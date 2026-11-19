"""
AURA Lyrics Engine — Multi-Source Synced Lyrics with Smart Word Interpolation.

Sources (checked in priority order):
  1. LRCLIB exact match  → native word-sync YAML → enhanced LRC → standard LRC
  2. LRCLIB fuzzy search  → native word-sync YAML → enhanced LRC → standard LRC
  3. lyrics.ovh           → plain text fallback

Word-level sync:
  - If the source provides native word timestamps (LRCLIB lyricsfile YAML or
    Enhanced LRC <mm:ss.xx>), those are used directly.
  - Otherwise, words are interpolated from line timestamps using syllable-
    weighted proportional timing with natural pause injection.
"""

import re
from typing import Any, Dict, List, Optional, Tuple

import httpx
import yaml

# ─────────── constants / regex ───────────

LRCLIB_HEADERS = {"User-Agent": "AURA-Music/2.0 (https://github.com/aura-music)"}
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
    # Strip trailing separators and whitespace.
    cleaned = re.sub(r"\s*[-|–—]\s*$", "", cleaned).strip()
    # Remove double spaces.
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned or title.strip()


def _clean_artist(artist: str) -> str:
    """Return the primary artist name, stripped of features / collaborators."""
    # Take the first artist before any separator.
    primary = re.split(r"[,&x×/]|\bfeat\.?\b|\bft\.?\b|\bwith\b|\band\b", artist, flags=re.IGNORECASE)[0]
    return primary.strip() or artist.strip()


def _parse_ts(m: str, s: str, frac: Optional[str]) -> float:
    minutes = int(m)
    seconds = int(s)
    if not frac:
        return minutes * 60 + seconds
    return minutes * 60 + seconds + (int(frac) / (1000.0 if len(frac) == 3 else 100.0))


# ─────────── syllable / word interpolation ───────────


def _estimate_syllables(word: str) -> float:
    """Estimate the spoken syllable count of a word (for timing weight)."""
    w = re.sub(r"[^a-zA-Z\u00C0-\u024F\u0900-\u097F\u0A00-\u0A7F]", "", word)
    if not w:
        return 1.0

    # Non-Latin scripts: rough 1 syllable per character.
    if re.search(r"[\u0900-\u097F\u0A00-\u0A7F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]", w):
        return max(1.0, len(w) * 0.9)

    # Latin-based vowel-cluster heuristic.
    vowel_groups = re.findall(r"[aeiouyàáâäãåæèéêëìíîïòóôöõùúûüýÿ]+", w.lower())
    count = max(1, len(vowel_groups))
    # Silent-e in English.
    if w.lower().endswith("e") and count > 1 and not w.lower().endswith(("le", "ie", "ye")):
        count -= 1
    # Common contractions (-tion, -sion) are one syllable, not two.
    if re.search(r"(?:tion|sion)$", w.lower()):
        count = max(1, count - 1)

    # Punctuation pauses (the word still takes its timing + pause gap).
    if word and word[-1] in ",;:":
        return float(count) + 0.3
    if word and word[-1] in ".!?":
        return float(count) + 0.6
    return float(count)


def _interpolate_words(text: str, start: float, end: float) -> List[Dict[str, Any]]:
    """
    Split a line's text into words and assign each word a proportional time
    window based on estimated syllable counts.

    The singing window is capped so that instrumental gaps between lines don't
    stretch the last word absurdly.
    """
    raw_words = text.split()
    if not raw_words:
        return []

    # Cap the singing window: at most ~0.5s per word (generous) or the actual gap.
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


# ─────────── LRCLIB fetcher ───────────


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
            timeout=7.0,
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
            timeout=7.0,
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


async def _lyrics_ovh_fallback(
    client: httpx.AsyncClient,
    title: str,
    artist: str,
) -> str:
    """Fetch plain lyrics from lyrics.ovh as a last resort."""
    try:
        # URL-encode slashes in title/artist.
        safe_artist = artist.replace("/", " ")
        safe_title = title.replace("/", " ")
        resp = await client.get(
            f"https://api.lyrics.ovh/v1/{safe_artist}/{safe_title}",
            timeout=8.0,
        )
        if resp.status_code == 200:
            data = resp.json()
            return (data.get("lyrics") or "").strip()
    except Exception:
        pass
    return ""


def _build_result(record: Dict[str, Any], duration: Optional[int]) -> Optional[Dict[str, Any]]:
    """Convert a LRCLIB record to our internal lyrics format.  Returns None if unusable."""
    plain = record.get("plainLyrics") or ""

    # Priority A: Native Word-Synced Lyricsfile YAML.
    if record.get("hasWordSync") and record.get("lyricsfile"):
        yaml_lines = parse_lyricsfile_yaml(record["lyricsfile"])
        if yaml_lines:
            return {"synced": True, "word_native": True, "plain_text": plain, "lines": yaml_lines}

    # Priority B: Synced LRC (Enhanced or Standard + syllable interpolation).
    if record.get("syncedLyrics"):
        lines = parse_lrc(record["syncedLyrics"], float(duration or 240))
        if lines:
            is_native = "<" in record["syncedLyrics"] and ">" in record["syncedLyrics"]
            return {"synced": True, "word_native": is_native, "plain_text": plain, "lines": lines}

    # Priority C: Plain unsynced lyrics.
    if plain:
        return _wrap_plain(plain)

    return None


def _wrap_plain(plain: str) -> Dict[str, Any]:
    """Wrap plain text lyrics into our format with start=-1 (unsynced)."""
    plain_lines = [
        {
            "text": ln.strip(),
            "start": -1,
            "end": -1,
            "words": [{"text": w, "start": -1, "end": -1} for w in ln.strip().split()],
        }
        for ln in plain.splitlines()
        if ln.strip()
    ]
    return {"synced": False, "word_native": False, "plain_text": plain, "lines": plain_lines}


EMPTY_RESULT: Dict[str, Any] = {"synced": False, "word_native": False, "plain_text": "", "lines": []}


async def fetch_synced_lyrics(
    client: httpx.AsyncClient,
    title: str,
    artist: str,
    duration: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Multi-strategy lyrics fetcher.

    Strategy order:
      1. LRCLIB exact match with cleaned title + primary artist (± duration).
      2. LRCLIB exact match with original title + primary artist.
      3. LRCLIB fuzzy search "cleaned_title cleaned_artist".
      4. LRCLIB fuzzy search "cleaned_title" only (helps when artist name differs).
      5. lyrics.ovh plain text fallback.
    """
    clean_title = clean_track_title(title)
    primary_artist = _clean_artist(artist)

    # ── Strategy 1: exact match (cleaned) ──
    record = await _lrclib_exact(client, clean_title, primary_artist, duration)
    if record:
        result = _build_result(record, duration)
        if result:
            return result

    # ── Strategy 2: exact match (original title, in case cleaning was too aggressive) ──
    if clean_title != title.strip():
        record = await _lrclib_exact(client, title.strip(), primary_artist, duration)
        if record:
            result = _build_result(record, duration)
            if result:
                return result

    # ── Strategy 3: fuzzy search "title artist" ──
    q_full = f"{clean_title} {primary_artist}".strip()
    record = await _lrclib_search(client, q_full, duration)
    if record:
        result = _build_result(record, duration)
        if result:
            return result

    # ── Strategy 4: fuzzy search with title only (helps when artist names diverge) ──
    if clean_title != q_full:
        record = await _lrclib_search(client, clean_title, duration)
        if record:
            result = _build_result(record, duration)
            if result:
                return result

    # ── Strategy 5: lyrics.ovh plain fallback ──
    plain = await _lyrics_ovh_fallback(client, clean_title, primary_artist)
    if not plain and clean_title != title.strip():
        plain = await _lyrics_ovh_fallback(client, title.strip(), primary_artist)
    if plain:
        return _wrap_plain(plain)

    return EMPTY_RESULT
