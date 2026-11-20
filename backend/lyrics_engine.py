"""
AURA Lyrics Engine — Multi-Source Synced Lyrics with Smart Word Interpolation & Dynamic Auto-Pacing.

Sources (checked in priority order):
  1. LRCLIB exact match   → native word-sync YAML → enhanced LRC → standard LRC
  2. LRCLIB fuzzy search  → native word-sync YAML → enhanced LRC → standard LRC
  3. NetEase CloudSearch  → synced LRC (huge database of Bollywood, Punjabi, Asian, Pop & Global tracks)
  4. Plain lyrics sources (LRCLIB, NetEase, lyrics.ovh) → Smart Dynamic Auto-Pacing Engine

Word-level & Line-level sync:
  - If the source provides native word timestamps (LRCLIB lyricsfile YAML or Enhanced LRC <mm:ss.xx>),
    those are used directly.
  - If standard LRC is provided, lines have exact millisecond timestamps and words are interpolated
    via syllable-weighted pacing.
  - If only plain text lyrics exist, the Smart Pacing Engine calculates musical line and word timings
    based on song duration, intro estimation, stanza intervals, syllable weight, and punctuation.
    Result: 100% of tracks with lyrics are actively synchronized and interactive!
"""

import re
from typing import Any, Dict, List, Optional, Tuple

import httpx
import yaml

# ─────────── constants / regex ───────────

LRCLIB_HEADERS = {"User-Agent": "AURA-Music/2.0 (https://github.com/aura-music)"}
NETEASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Referer": "https://music.163.com/",
}

LINE_LRC_RE = re.compile(r"\[(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?\]\s*(.*)")
ENHANCED_WORD_RE = re.compile(r"<(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?>([^<]+)")

# Noise that YouTube/YT Music titles carry but that lyrics DBs do not.
TITLE_NOISE_RE = re.compile(
    r"""(?ix)
        (\(|\[|\|).*?
        (official|video|audio|lyric|hd|4k|hq|remaster|feat\.?|ft\.?
         |full\s*song|music\s*video|visuali[sz]er|explicit|clean
         |radio\s*edit|extended|remix|live|acoustic|slowed|reverb
         |sped\s*up|bass\s*boosted|karaoke|instrumental)
        .*?(\)|\]|$)
    """,
)


# ─────────── helpers ───────────


def clean_track_title(title: str) -> str:
    """Strip YouTube-style noise from a title so it matches lyrics databases."""
    cleaned = TITLE_NOISE_RE.sub("", title)
    cleaned = re.sub(r"\s*[-|–—]\s*$", "", cleaned).strip()
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned or title.strip()


def _clean_artist(artist: str) -> str:
    """Return the primary artist name, stripped of features / collaborators."""
    primary = re.split(r"[,&x×/]|\bfeat\.?\b|\bft\.?\b|\bwith\b|\band\b", artist, flags=re.IGNORECASE)[0]
    return primary.strip() or artist.strip()


def _parse_ts(m: str, s: str, frac: Optional[str]) -> float:
    minutes = int(m)
    seconds = int(s)
    if not frac:
        return minutes * 60 + seconds
    return minutes * 60 + seconds + (int(frac) / (1000.0 if len(frac) == 3 else 100.0))


def _is_title_relevant(candidate_title: str, query_title: str) -> bool:
    """Check if candidate song name from NetEase is relevant to requested track title."""
    clean_c = re.sub(r"[^a-zA-Z0-9\s]", " ", candidate_title.lower())
    clean_q = re.sub(r"[^a-zA-Z0-9\s]", " ", clean_track_title(query_title).lower())
    c_words = set(w for w in clean_c.split() if len(w) > 2)
    q_words = set(w for w in clean_q.split() if len(w) > 2)
    if not q_words:
        return True
    return bool(c_words & q_words)


# ─────────── syllable / word interpolation ───────────


def _estimate_syllables(word: str) -> float:
    """Estimate the spoken syllable count of a word (for timing weight)."""
    w = re.sub(r"[^a-zA-Z\u00C0-\u024F\u0900-\u097F\u0A00-\u0A7F]", "", word)
    if not w:
        return 1.0

    # Non-Latin scripts (Devanagari, Gurmukhi, CJK): ~0.85 syllable per character.
    if re.search(r"[\u0900-\u097F\u0A00-\u0A7F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]", w):
        return max(1.0, len(w) * 0.85)

    vowel_groups = re.findall(r"[aeiouyàáâäãåæèéêëìíîïòóôöõùúûüýÿ]+", w.lower())
    count = max(1, len(vowel_groups))
    if w.lower().endswith("e") and count > 1 and not w.lower().endswith(("le", "ie", "ye")):
        count -= 1
    if re.search(r"(?:tion|sion)$", w.lower()):
        count = max(1, count - 1)

    pause = 0.3 if word and word[-1] in ",;:" else (0.6 if word and word[-1] in ".!?" else 0.0)
    return float(count) + pause


def _interpolate_words(text: str, start: float, end: float) -> List[Dict[str, Any]]:
    """
    Split a line's text into words and assign each word a proportional time
    window based on estimated syllable counts.
    """
    raw_words = text.split()
    if not raw_words:
        return []

    max_singing = max(1.5, len(raw_words) * 0.50)
    duration = max(0.3, min(end - start, max_singing))

    weights = [_estimate_syllables(w) for w in raw_words]
    total_w = sum(weights) or 1.0

    cursor = start
    words: List[Dict[str, Any]] = []
    for w, weight in zip(raw_words, weights):
        w_dur = (weight / total_w) * duration
        words.append({
            "text": w,
            "start": round(cursor, 3),
            "end": round(cursor + w_dur, 3),
        })
        cursor += w_dur
    return words


# ─────────── Smart Dynamic Auto-Pacing Engine ───────────


def generate_smart_paced_lyrics(plain_text: str, duration_sec: Optional[int]) -> List[Dict[str, Any]]:
    """
    Turn plain unsynced lyrics into musically realistic line and word timings.

    Features:
      - Filters out section headings (e.g. [Chorus], [Verse 1]).
      - Preserves stanza boundaries to introduce natural musical breathers/interludes.
      - Estimates song intro (~5.5% of duration, 8s to 20s) and outro (~5.5%).
      - Weights lines by syllable counts and punctuation.
      - Generates word-level timestamps via syllable interpolation.
    """
    raw_stanzas = plain_text.strip().split("\n\n")
    stanzas: List[List[str]] = []

    for s in raw_stanzas:
        lines: List[str] = []
        for ln in s.splitlines():
            clean = ln.strip()
            if not clean:
                continue
            # Filter section header brackets like [Verse], [Chorus], (Chorus), etc.
            if re.match(r"^(\[|\()(verse|chorus|hook|bridge|intro|outro|pre-chorus|refrain|\d+).*?(\]|\))$", clean, re.I):
                continue
            lines.append(clean)
        if lines:
            stanzas.append(lines)

    all_lines = [ln for s in stanzas for ln in s]
    if not all_lines:
        return []

    dur = float(duration_sec or 240)
    if dur < 30:
        dur = 210.0

    # Intro and outro estimates
    intro = min(22.0, max(8.0, dur * 0.055))
    outro = min(20.0, max(8.0, dur * 0.055))
    usable_time = max(20.0, dur - intro - outro)

    num_gaps = max(0, len(stanzas) - 1)
    gap_duration = 2.5
    total_gaps_time = min(num_gaps * gap_duration, usable_time * 0.22)
    line_time_budget = usable_time - total_gaps_time

    line_weights = [sum(_estimate_syllables(w) for w in ln.split()) for ln in all_lines]
    total_weight = sum(line_weights) or 1.0

    result: List[Dict[str, Any]] = []
    cursor = intro
    w_idx = 0

    for s_i, stanza in enumerate(stanzas):
        for ln in stanza:
            weight = line_weights[w_idx]
            w_idx += 1
            line_dur = (weight / total_weight) * line_time_budget
            line_dur = max(1.8, min(8.5, line_dur))

            start = round(cursor, 3)
            end = round(cursor + line_dur, 3)
            cursor += line_dur

            raw_words = ln.split()
            ww = [_estimate_syllables(w) for w in raw_words]
            tot_ww = sum(ww) or 1.0
            w_cur = start
            words = []
            for w, w_w in zip(raw_words, ww):
                wd = (w_w / tot_ww) * line_dur
                words.append({"text": w, "start": round(w_cur, 3), "end": round(w_cur + wd, 3)})
                w_cur += wd

            result.append({"text": ln, "start": start, "end": end, "words": words})

        if s_i < num_gaps:
            cursor += (total_gaps_time / num_gaps) if num_gaps > 0 else 0

    return result


# ─────────── LRC parsers ───────────


def parse_lyricsfile_yaml(raw_yaml: str) -> Optional[List[Dict[str, Any]]]:
    """Parse LRCLIB Lyricsfile YAML containing native word-level timings."""
    try:
        doc = yaml.safe_load(raw_yaml)
        if not isinstance(doc, dict) or not doc.get("lines"):
            return None

        parsed_lines: List[Dict[str, Any]] = []
        raw_lines = doc["lines"]

        for idx, line in enumerate(raw_lines):
            text = (line.get("text") or "").strip()
            if not text:
                continue

            start_ms = line.get("start_ms")
            end_ms = line.get("end_ms")
            if start_ms is None:
                continue

            start_s = start_ms / 1000.0
            if end_ms is not None:
                end_s = end_ms / 1000.0
            elif idx + 1 < len(raw_lines) and raw_lines[idx + 1].get("start_ms") is not None:
                end_s = raw_lines[idx + 1]["start_ms"] / 1000.0
            else:
                end_s = start_s + 4.0

            yaml_words = line.get("words")
            words: List[Dict[str, Any]] = []
            if isinstance(yaml_words, list) and yaml_words:
                for w_idx, w in enumerate(yaml_words):
                    w_text = (w.get("text") or "").strip()
                    if not w_text:
                        continue
                    ws = (w.get("start_ms", start_ms)) / 1000.0
                    if w.get("end_ms") is not None:
                        we = w["end_ms"] / 1000.0
                    elif w_idx + 1 < len(yaml_words) and yaml_words[w_idx + 1].get("start_ms") is not None:
                        we = yaml_words[w_idx + 1]["start_ms"] / 1000.0
                    else:
                        we = max(ws + 0.35, end_s)
                    words.append({"text": w_text, "start": round(ws, 3), "end": round(we, 3)})
            else:
                words = _interpolate_words(text, start_s, end_s)

            parsed_lines.append({
                "text": text,
                "start": round(start_s, 3),
                "end": round(end_s, 3),
                "words": words,
            })

        return parsed_lines or None
    except Exception:
        return None


def parse_lrc(lrc_text: str, track_duration: float = 240.0) -> List[Dict[str, Any]]:
    """Parse Enhanced LRC (<mm:ss.xx>) or standard LRC ([mm:ss.xx])."""
    raw_entries: List[Dict[str, Any]] = []

    for raw in lrc_text.splitlines():
        match = LINE_LRC_RE.match(raw.strip())
        if not match:
            continue
        start = _parse_ts(match.group(1), match.group(2), match.group(3))
        body = match.group(4).strip()
        if not body:
            continue
        # Skip metadata header lines in LRC (e.g. [00:00.00] Producer: / Lyricist: / 作词 : )
        if start < 3.0 and re.match(r"^(作词|作曲|制作|producer|lyrics|artist|album|by|encoded|offset|ti|ar|al|by):", body, re.I):
            continue
        raw_entries.append({"start": start, "body": body})

    raw_entries.sort(key=lambda x: x["start"])
    lines: List[Dict[str, Any]] = []

    for idx, entry in enumerate(raw_entries):
        start = entry["start"]
        next_start = raw_entries[idx + 1]["start"] if idx + 1 < len(raw_entries) else max(track_duration, start + 4.5)
        end = max(start + 0.5, next_start)
        body = entry["body"]

        # Check for Enhanced LRC inline word timestamps.
        enh_matches = list(ENHANCED_WORD_RE.finditer(body))
        if enh_matches:
            words = []
            clean_tokens = []
            for w_idx, m in enumerate(enh_matches):
                ws = _parse_ts(m.group(1), m.group(2), m.group(3))
                wt = m.group(4).strip()
                if not wt:
                    continue
                if w_idx + 1 < len(enh_matches):
                    nm = enh_matches[w_idx + 1]
                    we = _parse_ts(nm.group(1), nm.group(2), nm.group(3))
                else:
                    we = min(end, ws + 0.8)
                words.append({"text": wt, "start": round(ws, 3), "end": round(max(we, ws + 0.12), 3)})
                clean_tokens.append(wt)
            lines.append({
                "text": " ".join(clean_tokens),
                "start": round(start, 3),
                "end": round(end, 3),
                "words": words,
            })
        else:
            lines.append({
                "text": body,
                "start": round(start, 3),
                "end": round(end, 3),
                "words": _interpolate_words(body, start, end),
            })

    return lines


# ─────────── Remote Fetchers ───────────


def _score_candidate(item: Dict[str, Any], duration: Optional[int]) -> Tuple[int, int, float]:
    """Score a LRCLIB search result — higher is better."""
    has_ws = 1 if item.get("hasWordSync") else 0
    has_sync = 1 if item.get("syncedLyrics") else 0
    dur_diff = -abs((item.get("duration") or 0) - (duration or 0)) if duration else 0.0
    return (has_ws, has_sync, dur_diff)


async def _lrclib_exact(
    client: httpx.AsyncClient,
    title: str,
    artist: str,
    duration: Optional[int],
) -> Optional[Dict[str, Any]]:
    """LRCLIB /api/get — exact metadata match."""
    params: Dict[str, Any] = {"track_name": title, "artist_name": artist}
    if duration and duration > 0:
        params["duration"] = int(duration)
    try:
        resp = await client.get(
            "https://lrclib.net/api/get",
            params=params,
            headers=LRCLIB_HEADERS,
            timeout=6.0,
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("syncedLyrics") or data.get("hasWordSync") or data.get("plainLyrics"):
                return data
    except Exception:
        pass
    return None


async def _lrclib_search(
    client: httpx.AsyncClient,
    query: str,
    duration: Optional[int],
) -> Optional[Dict[str, Any]]:
    """LRCLIB /api/search — fuzzy text search."""
    try:
        resp = await client.get(
            "https://lrclib.net/api/search",
            params={"q": query},
            headers=LRCLIB_HEADERS,
            timeout=6.0,
        )
        if resp.status_code == 200:
            candidates = resp.json()
            if isinstance(candidates, list) and candidates:
                candidates.sort(key=lambda c: _score_candidate(c, duration), reverse=True)
                best = candidates[0]
                if best.get("syncedLyrics") or best.get("hasWordSync") or best.get("plainLyrics"):
                    return best
    except Exception:
        pass
    return None


async def _netease_search(
    client: httpx.AsyncClient,
    title: str,
    artist: str,
) -> Tuple[Optional[str], Optional[str]]:
    """
    Search NetEase CloudMusic for synced LRC and plain lyrics.
    Returns (synced_lrc, plain_lyrics).
    """
    queries = [
        f"{title} {artist}".strip(),
        title.strip(),
    ]
    for q in queries:
        try:
            url = "https://music.163.com/api/cloudsearch/pc"
            params = {"s": q, "type": "1", "offset": "0", "limit": "5"}
            resp = await client.get(url, params=params, headers=NETEASE_HEADERS, timeout=5.0)
            if resp.status_code != 200:
                continue
            data = resp.json()
            songs = data.get("result", {}).get("songs", [])
            for s in songs:
                if not _is_title_relevant(s.get("name", ""), title):
                    continue
                sid = s.get("id")
                if not sid:
                    continue
                l_url = "https://music.163.com/api/song/lyric"
                l_params = {"id": str(sid), "lv": "1", "kv": "1", "tv": "-1"}
                l_resp = await client.get(l_url, params=l_params, headers=NETEASE_HEADERS, timeout=5.0)
                if l_resp.status_code == 200:
                    ldata = l_resp.json()
                    lrc = ldata.get("lrc", {}).get("lyric", "")
                    if lrc and "[" in lrc and re.search(r"\[\d{1,2}:\d{2}", lrc):
                        return lrc, None
                    if lrc and not ("[" in lrc):
                        return None, lrc
        except Exception:
            continue
    return None, None


async def _lyrics_ovh_fallback(
    client: httpx.AsyncClient,
    title: str,
    artist: str,
) -> str:
    """Fetch plain lyrics from lyrics.ovh as a last resort."""
    try:
        safe_artist = artist.replace("/", " ")
        safe_title = title.replace("/", " ")
        resp = await client.get(
            f"https://api.lyrics.ovh/v1/{safe_artist}/{safe_title}",
            timeout=6.0,
        )
        if resp.status_code == 200:
            data = resp.json()
            return (data.get("lyrics") or "").strip()
    except Exception:
        pass
    return ""


EMPTY_RESULT: Dict[str, Any] = {
    "synced": False,
    "word_native": False,
    "smart_sync": False,
    "plain_text": "",
    "lines": [],
}


async def fetch_synced_lyrics(
    client: httpx.AsyncClient,
    title: str,
    artist: str,
    duration: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Multi-source lyrics engine.

    Pipeline:
      1. Check LRCLIB exact match (/api/get).
      2. Check LRCLIB fuzzy search (/api/search).
      3. If real word-sync YAML is found: return immediately with word_native=True.
      4. If real synced LRC is found on LRCLIB: return immediately with synced=True.
      5. Check NetEase CloudMusic for synced LRC: return immediately with synced=True.
      6. If only plain lyrics were found (from LRCLIB, NetEase, or lyrics.ovh):
         Run the Smart Dynamic Auto-Pacing Engine!
         Every line and word gets rhythmic timestamps based on song duration,
         intro/outro estimation, stanza breathers, and syllable counts.
         Sets synced=True, smart_sync=True!
      7. Result: 100% of songs with lyrics are synced and interactive!
    """
    clean_title = clean_track_title(title)
    primary_artist = _clean_artist(artist)

    collected_plain: str = ""

    # ── 1. LRCLIB exact match ──
    rec = await _lrclib_exact(client, clean_title, primary_artist, duration)
    if not rec and clean_title != title.strip():
        rec = await _lrclib_exact(client, title.strip(), primary_artist, duration)

    if rec:
        if rec.get("hasWordSync") and rec.get("lyricsfile"):
            y_lines = parse_lyricsfile_yaml(rec["lyricsfile"])
            if y_lines:
                return {
                    "synced": True,
                    "word_native": True,
                    "smart_sync": False,
                    "plain_text": rec.get("plainLyrics") or "",
                    "lines": y_lines,
                }
        if rec.get("syncedLyrics"):
            l_lines = parse_lrc(rec["syncedLyrics"], float(duration or 240))
            if l_lines:
                is_native = "<" in rec["syncedLyrics"] and ">" in rec["syncedLyrics"]
                return {
                    "synced": True,
                    "word_native": is_native,
                    "smart_sync": False,
                    "plain_text": rec.get("plainLyrics") or "",
                    "lines": l_lines,
                }
        if rec.get("plainLyrics"):
            collected_plain = rec["plainLyrics"].strip()

    # ── 2. LRCLIB fuzzy search ──
    q_full = f"{clean_title} {primary_artist}".strip()
    rec2 = await _lrclib_search(client, q_full, duration)
    if not rec2 and clean_title != q_full:
        rec2 = await _lrclib_search(client, clean_title, duration)

    if rec2:
        if rec2.get("hasWordSync") and rec2.get("lyricsfile"):
            y_lines = parse_lyricsfile_yaml(rec2["lyricsfile"])
            if y_lines:
                return {
                    "synced": True,
                    "word_native": True,
                    "smart_sync": False,
                    "plain_text": rec2.get("plainLyrics") or "",
                    "lines": y_lines,
                }
        if rec2.get("syncedLyrics"):
            l_lines = parse_lrc(rec2["syncedLyrics"], float(duration or 240))
            if l_lines:
                is_native = "<" in rec2["syncedLyrics"] and ">" in rec2["syncedLyrics"]
                return {
                    "synced": True,
                    "word_native": is_native,
                    "smart_sync": False,
                    "plain_text": rec2.get("plainLyrics") or "",
                    "lines": l_lines,
                }
        if not collected_plain and rec2.get("plainLyrics"):
            collected_plain = rec2["plainLyrics"].strip()

    # ── 3. NetEase CloudMusic search ──
    ne_lrc, ne_plain = await _netease_search(client, clean_title, primary_artist)
    if ne_lrc:
        l_lines = parse_lrc(ne_lrc, float(duration or 240))
        if l_lines:
            return {
                "synced": True,
                "word_native": False,
                "smart_sync": False,
                "plain_text": collected_plain or "",
                "lines": l_lines,
            }
    if not collected_plain and ne_plain:
        collected_plain = ne_plain.strip()

    # ── 4. lyrics.ovh plain fallback ──
    if not collected_plain:
        ovh_text = await _lyrics_ovh_fallback(client, clean_title, primary_artist)
        if not ovh_text and clean_title != title.strip():
            ovh_text = await _lyrics_ovh_fallback(client, title.strip(), primary_artist)
        if ovh_text:
            collected_plain = ovh_text.strip()

    # ── 5. Smart Dynamic Auto-Pacing Engine for Plain Lyrics ──
    if collected_plain:
        smart_lines = generate_smart_paced_lyrics(collected_plain, duration)
        if smart_lines:
            return {
                "synced": True,
                "word_native": False,
                "smart_sync": True,
                "plain_text": collected_plain,
                "lines": smart_lines,
            }

    return EMPTY_RESULT
