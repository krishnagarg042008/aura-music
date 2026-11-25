/**
 * Pure utility helpers for client-side LRC parsing, LAN host detection, and queue shuffling.
 */

const LINE_LRC_RE = /^\[(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?\]\s*(.*)$/;
const ENHANCED_WORD_RE = /<(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?>([^<]+)/g;
const LRC_HEADER_RE = /^(作词|作曲|制作|编曲|混音|母带|producer|lyricist|lyrics|artist|album|composer|arranger|by|encoded|offset|ti|ar|al)\s*[:：]/i;
const SECTION_TAG_RE = /^(\[|\()(verse|chorus|hook|bridge|intro|outro|pre-chorus|refrain|\d+).*?(\]|\))$/i;

function parseTimestamp(m, s, frac) {
  const minutes = parseInt(m, 10);
  const seconds = parseInt(s, 10);
  if (!frac) return minutes * 60 + seconds;
  const denom = frac.length === 3 ? 1000 : 100;
  return minutes * 60 + seconds + parseInt(frac, 10) / denom;
}

function interpolateWords(text, start, end) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const lineSpan = Math.max(0.4, end - start);
  const singingSpan = lineSpan > 1.2 ? Math.max(0.35, lineSpan - 0.25) : lineSpan;
  const weights = tokens.map((w) => Math.max(1, w.length * 0.6));
  const total = weights.reduce((acc, v) => acc + v, 0) || 1;
  let cursor = start;

  return tokens.map((w, idx) => {
    const dur = (weights[idx] / total) * singingSpan;
    const item = {
      text: w,
      start: Math.round(cursor * 1000) / 1000,
      end: Math.round((cursor + dur) * 1000) / 1000,
    };
    cursor += dur;
    return item;
  });
}

/**
 * Parse user-supplied LRC (standard or enhanced) or plain text into AURA's lyrics structure.
 */
export function parseClientLrc(rawText, trackDuration = 240) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) {
    return { synced: false, word_native: false, smart_sync: false, plain_text: "", lines: [] };
  }

  const rawEntries = [];
  for (const rawLine of trimmed.splitlines ? trimmed.splitlines() : trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = LINE_LRC_RE.exec(line);
    if (!m) continue;
    const start = parseTimestamp(m[1], m[2], m[3]);
    const body = m[4].trim();
    if (!body) continue;
    if (start < 3.0 && LRC_HEADER_RE.test(body)) continue;
    rawEntries.push({ start, body });
  }

  if (rawEntries.length > 0) {
    rawEntries.sort((a, b) => a.start - b.start);
    let hasEnhanced = false;
    const lines = rawEntries.map((entry, idx) => {
      const start = entry.start;
      const nextStart = idx + 1 < rawEntries.length
        ? rawEntries[idx + 1].start
        : Math.max(trackDuration || 240, start + 4.5);
      const end = Math.max(start + 0.5, nextStart);

      ENHANCED_WORD_RE.lastIndex = 0;
      const enhMatches = [...entry.body.matchAll(ENHANCED_WORD_RE)];
      if (enhMatches.length > 0) {
        hasEnhanced = true;
        const words = [];
        const cleanTokens = [];
        enhMatches.forEach((em, wIdx) => {
          const ws = parseTimestamp(em[1], em[2], em[3]);
          const wt = em[4].trim();
          if (!wt) return;
          let we;
          if (wIdx + 1 < enhMatches.length) {
            const nm = enhMatches[wIdx + 1];
            we = parseTimestamp(nm[1], nm[2], nm[3]);
          } else {
            we = Math.min(end, ws + 0.8);
          }
          words.push({
            text: wt,
            start: Math.round(ws * 1000) / 1000,
            end: Math.round(Math.max(we, ws + 0.12) * 1000) / 1000,
          });
          cleanTokens.push(wt);
        });
        return {
          text: cleanTokens.join(" "),
          start: Math.round(start * 1000) / 1000,
          end: Math.round(end * 1000) / 1000,
          words,
        };
      }

      return {
        text: entry.body,
        start: Math.round(start * 1000) / 1000,
        end: Math.round(end * 1000) / 1000,
        words: interpolateWords(entry.body, start, end),
      };
    });

    return {
      synced: true,
      word_native: hasEnhanced,
      smart_sync: false,
      plain_text: lines.map((l) => l.text).join("\n"),
      lines,
    };
  }

  // Fallback to plain lyrics
  const plainLines = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const clean = rawLine.trim();
    if (!clean || SECTION_TAG_RE.test(clean)) continue;
    plainLines.push({
      text: clean,
      start: -1,
      end: -1,
      words: clean.split(/\s+/).filter(Boolean).map((w) => ({ text: w, start: -1, end: -1 })),
    });
  }

  return {
    synced: false,
    word_native: false,
    smart_sync: false,
    plain_text: trimmed,
    lines: plainLines,
  };
}

/**
 * Determine whether the current hostname is local or on a private LAN (supports mobile Wi-Fi streaming).
 */
export function isLocalOrLanHostname(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".local")) {
    return true;
  }
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  const m172 = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (m172) {
    const second = parseInt(m172[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Shuffle upcoming tracks in queue while keeping the currently playing track at index 0.
 */
export function buildShuffledQueue(queue, currentIndex, rng = Math.random) {
  if (!Array.isArray(queue) || queue.length <= 1) {
    return { queue: Array.isArray(queue) ? [...queue] : [], currentIndex };
  }
  const hasCurrent = currentIndex >= 0 && currentIndex < queue.length;
  const active = hasCurrent ? queue[currentIndex] : null;
  const rest = hasCurrent ? queue.filter((_, i) => i !== currentIndex) : [...queue];

  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }

  if (active) {
    return { queue: [active, ...rest], currentIndex: 0 };
  }
  return { queue: rest, currentIndex: -1 };
}
