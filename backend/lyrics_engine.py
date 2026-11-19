import re
from typing import Any, Dict, List, Optional
import httpx
import yaml

LRCLIB_HEADERS = {"User-Agent": "AURA-Music/1.0 (https://github.com/aura-music)"}
LINE_LRC_RE = re.compile(r"\[(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?\]\s*(.*)")
ENHANCED_WORD_RE = re.compile(r"<(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?>\s*([^<]+)")


def clean_track_title(title: str) -> str:
    cleaned = re.sub(
        r"(\(|\[|\|).*?(official|video|audio|lyric|hd|4k|hq|remaster|feat\.?|ft\.?|full song|music video).*?(\)|\]|$)",
        "",
        title,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"\s*[-|–]\s*$", "", cleaned).strip()
    return cleaned or title.strip()


def _parse_ts(m: str, s: str, frac: Optional[str]) -> float:
    minutes = int(m)
    seconds = int(s)
    if not frac:
        return minutes * 60 + seconds
    return minutes * 60 + seconds + (int(frac) / (1000.0 if len(frac) == 3 else 100.0))


def _estimate_syllables(word: str) -> float:
    w = re.sub(r"[^a-zA-Z]", "", word.lower())
    if not w:
        return 1.0
    groups = re.findall(r"[aeiouy]+", w)
    count = max(1, len(groups))
    if w.endswith("e") and count > 1:
        count -= 1
    # Punctuation pause weight
    pause = 0.45 if word[-1] in ",;:" else (0.75 if word[-1] in ".!?" else 0.0)
    return float(count) + pause


def _interpolate_words(text: str, start: float, end: float) -> List[Dict[str, Any]]:
    raw_words = text.split()
    if not raw_words:
        return []

    # Cap singing window so instrumental gaps don't stretch the final word
    duration = max(0.4, min(end - start, max(1.8, len(raw_words) * 0.55)))
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
    """Parse Enhanced LRC (<mm:ss.xx>) or standard LRC ([mm:ss.xx]) into word-synced objects."""
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

        # Check for Enhanced LRC inline word timestamps
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


async def fetch_synced_lyrics(
    client: httpx.AsyncClient,
    title: str,
    artist: str,
    duration: Optional[int] = None,
) -> Dict[str, Any]:
    clean_title = clean_track_title(title)
    clean_artist = artist.split(",")[0].split("&")[0].strip()

    record: Optional[Dict[str, Any]] = None

    # 1. Exact match via /api/get
    try:
        params: Dict[str, Any] = {"track_name": clean_title, "artist_name": clean_artist}
        if duration and duration > 0:
            params["duration"] = int(duration)
        resp = await client.get("https://lrclib.net/api/get", params=params, headers=LRCLIB_HEADERS, timeout=7.0)
        if resp.status_code == 200:
            record = resp.json()
    except Exception:
        pass

    # 2. Fuzzy search fallback via /api/search
    if not record or (not record.get("syncedLyrics") and not record.get("hasWordSync")):
        try:
            q = f"{clean_title} {clean_artist}".strip()
            resp = await client.get("https://lrclib.net/api/search", params={"q": q}, headers=LRCLIB_HEADERS, timeout=7.0)
            if resp.status_code == 200:
                candidates = resp.json()
                if isinstance(candidates, list) and candidates:
                    # Prefer native word-sync -> line-sync -> duration closeness
                    def score(item: Dict[str, Any]) -> Tuple[int, int, float]:
                        has_ws = 1 if item.get("hasWordSync") else 0
                        has_sync = 1 if item.get("syncedLyrics") else 0
                        dur_diff = -abs((item.get("duration") or 0) - (duration or 0)) if duration else 0.0
                        return (has_ws, has_sync, dur_diff)

                    candidates.sort(key=score, reverse=True)
                    record = candidates[0]
        except Exception:
            pass

    if not record:
        return {"synced": False, "word_native": False, "plain_text": "", "lines": []}

    plain = record.get("plainLyrics") or ""

    # Priority A: Native Word-Synced Lyricsfile YAML
    if record.get("hasWordSync") and record.get("lyricsfile"):
        yaml_lines = parse_lyricsfile_yaml(record["lyricsfile"])
        if yaml_lines:
            return {"synced": True, "word_native": True, "plain_text": plain, "lines": yaml_lines}

    # Priority B: Synced LRC (Enhanced or Standard + Syllable Interpolation)
    if record.get("syncedLyrics"):
        lines = parse_lrc(record["syncedLyrics"], float(duration or 240))
        if lines:
            is_native = "<" in record["syncedLyrics"] and ">" in record["syncedLyrics"]
            return {"synced": True, "word_native": is_native, "plain_text": plain, "lines": lines}

    # Priority C: Plain unsynced lyrics
    if plain:
        plain_lines = [
            {"text": ln.strip(), "start": -1, "end": -1, "words": [{"text": w, "start": -1, "end": -1} for w in ln.strip().split()]}
            for ln in plain.splitlines()
            if ln.strip()
        ]
        return {"synced": False, "word_native": False, "plain_text": plain, "lines": plain_lines}

    return {"synced": False, "word_native": False, "plain_text": "", "lines": []}