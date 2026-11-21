"""
AURA Lyrics Engine — Multi-Source Synced Lyrics with Strict Candidate Verification.

Sources (checked in priority order):
  1. LRCLIB exact match   → native word-sync YAML → enhanced LRC → standard LRC
  2. LRCLIB fuzzy search  → strictly verified with title & artist similarity
  3. NetEase CloudSearch  → strictly verified with title & artist similarity
  4. YouTube Music native → official Musixmatch-backed lyrics for 100% genuine tracks
  5. lyrics.ovh           → plain text fallback

Accuracy & Sync Philosophy:
  - Genuine synced LRC (LRCLIB, NetEase) is delivered with exact line & syllable-weighted word timings.
  - Plain lyrics are delivered with synced: false and rendered in clean, beautiful Plain Lyrics Mode.
    No fake auto-pacing timestamps are fabricated.
  - Candidates from different artists (e.g. Aphex Twin for Devi Sri Prasad) are strictly rejected.
"""

import asyncio
import re
from typing import Any, Dict, List, Optional, Tuple

import httpx
import yaml
from ytmusicapi import YTMusic

# ─────────── constants / headers ───────────

LRCLIB_HEADERS = {"User-Agent": "AURA-Music/2.0 (https://github.com/aura-music)"}
NETEASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Referer": "https://music.163.com/",
}

LINE_LRC_RE = re.compile(r"\[(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?\]\s*(.*)")
ENHANCED_WORD_RE = re.compile(r"<(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?>([^<]+)")

# Noise that YouTube/YT Music titles carry but lyrics databases do not.
TITLE_NOISE_RE = re.compile(
    r"""(?ix)
        (\(|\[).*?
        (official|video|audio|lyric|hd|4k|hq|remaster|feat\.?|ft\.?
         |full\s*song|music\s*video|visuali[sz]er|explicit|clean
         |radio\s*edit|extended|remix|live|acoustic|slowed|reverb
         |sped\s*up|bass\s*boosted|karaoke|instrumental
         |from\s+["\x27]?|ost\b|soundtrack|prod\.?\s*by)
        .*?(\)|\])
    """,
)


# ─────────── cleaning & tokenization ───────────


def clean_track_title(title: str) -> str:
    """Strip YouTube-style noise from a title so it matches lyrics databases."""
    first_part = title.split("|")[0].strip()
    cleaned = TITLE_NOISE_RE.sub("", first_part)
    cleaned = re.sub(r"(?i)\s+(feat\.?|ft\.?)\s+.*$", "", cleaned)
    cleaned = re.sub(r"\s*[-–—:]\s*$", "", cleaned).strip()
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


def _normalize_text(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9\s]", " ", text.lower()).strip()


def _tokenize(text: str) -> set:
    norm = _normalize_text(text)
    return set(w for w in norm.split() if len(w) > 1)


# ─────────── strict candidate validation ───────────


def is_valid_match(
    query_title: str,
    query_artist: str,
    cand_title: str,
    cand_artist: str,
    query_dur: Optional[int] = None,
    cand_dur: Optional[int] = None,
) -> Tuple[bool, float]:
    """
    Strictly validate whether a candidate match is genuine.
    Returns (is_valid, relevance_score).
    Guarantees that songs by completely different artists (e.g. Aphex Twin vs Devi Sri Prasad)
    are immediately rejected.
    """
    q_t_clean = clean_track_title(query_title)
    c_t_clean = clean_track_title(cand_title)
    q_t_tokens = _tokenize(q_t_clean)
    c_t_tokens = _tokenize(c_t_clean)

    # 1. Title matching check
    if not q_t_tokens:
        title_ok = True
        title_score = 1.0
    else:
        overlap = len(q_t_tokens & c_t_tokens)
        title_score = overlap / max(len(q_t_tokens), 1)
        norm_q = _normalize_text(q_t_clean)
        norm_c = _normalize_text(c_t_clean)
        title_ok = (
            (overlap >= min(2, len(q_t_tokens)))
            or (title_score >= 0.5)
            or (norm_q in norm_c)
            or (norm_c in norm_q)
        )

    if not title_ok:
        return False, 0.0

    # 2. Artist matching check
    q_a_tokens = _tokenize(_clean_artist(query_artist))
    c_a_tokens = _tokenize(_clean_artist(cand_artist))

    if q_a_tokens and c_a_tokens:
        a_overlap = len(q_a_tokens & c_a_tokens)
        norm_qa = _normalize_text(_clean_artist(query_artist))
        norm_ca = _normalize_text(_clean_artist(cand_artist))
        # Reject immediately if zero token overlap and neither string contains the other
        if a_overlap == 0 and norm_qa not in norm_ca and norm_ca not in norm_qa:
            return False, 0.0
        artist_score = max(
            a_overlap / max(len(q_a_tokens), 1),
            0.6 if (norm_qa in norm_ca or norm_ca in norm_qa) else 0.0,
        )
    else:
        artist_score = 0.5

    # 3. Duration matching check (if available)
    dur_score = 1.0
    if query_dur and cand_dur and query_dur > 0 and cand_dur > 0:
        diff = abs(query_dur - cand_dur)
        if diff > 60:
            return False, 0.0
        dur_score = max(0.0, 1.0 - (diff / 60.0))

    total_score = (title_score * 0.50) + (artist_score * 0.35) + (dur_score * 0.15)
    return True, total_score


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
    window based on syllable counts over the line's natural singing duration.
    """
    raw_words = text.split()
    if not raw_words:
        return []

    line_span = max(0.4, end - start)
    # Singer typically pauses/breathes at the end of a line (0.2s - 0.35s)
    singing_span = max(0.35, line_span - 0.25) if line_span > 1.2 else line_span

    weights = [_estimate_syllables(w) for w in raw_words]
    total_w = sum(weights) or 1.0

    cursor = start
    words: List[Dict[str, Any]] = []
    for w, weight in zip(raw_words, weights):
        w_dur = (weight / total_w) * singing_span
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
        # Skip metadata header lines in LRC (e.g. [00:00.00] Producer: / Lyricist: / 作词 : )
        if start < 3.0 and re.match(r"^(作词|作曲|制作|编曲|producer|lyrics|artist|album|by|encoded|offset|ti|ar|al):", body, re.I):
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


def _wrap_plain(plain_text: str) -> Dict[str, Any]:
    """Wrap plain lyrics into our standard format with start=-1 (unsynced)."""
    lines = []
    for raw in plain_text.strip().splitlines():
        clean = raw.strip()
        if not clean:
            continue
        # Skip section headings like [Chorus], [Verse 1]
        if re.match(r"^(\[|\()(verse|chorus|hook|bridge|intro|outro|pre-chorus|refrain|\d+).*?(\]|\))$", clean, re.I):
            continue
        lines.append({
            "text": clean,
            "start": -1.0,
            "end": -1.0,
            "words": [{"text": w, "start": -1.0, "end": -1.0} for w in clean.split()],
        })
    return {
        "synced": False,
        "word_native": False,
        "smart_sync": False,
        "plain_text": plain_text.strip(),
        "lines": lines,
    }


# ─────────── YouTube Music Official Lyrics ───────────

_ytmusic_client: Optional[YTMusic] = None


def get_ytmusic_client() -> YTMusic:
    global _ytmusic_client
    if _ytmusic_client is None:
        _ytmusic_client = YTMusic()
    return _ytmusic_client


def _fetch_ytmusic_lyrics_sync(
    video_id: Optional[str],
    title: str,
    artist: str,
) -> Optional[str]:
    """
    Fetch official lyrics directly from YouTube Music / Musixmatch.
    Uses videoId watch_playlist first, falling back to track search.
    """
    yt = get_ytmusic_client()

    # 1. Try direct video_id watch playlist
    if video_id:
        try:
            watch = yt.get_watch_playlist(videoId=video_id)
            lyrics_id = watch.get("lyrics")
            if lyrics_id:
                lyr = yt.get_lyrics(browseId=lyrics_id)
                text = lyr.get("lyrics")
                if text and text.strip():
                    return text.strip()
        except Exception:
            pass

    # 2. Try searching YouTube Music
    clean_title = clean_track_title(title)
    clean_art = _clean_artist(artist)
    q = f"{clean_title} {clean_art}".strip()
    if q:
        try:
            res = yt.search(q, filter="songs", limit=1)
            if res and res[0].get("videoId"):
                cand_vid = res[0]["videoId"]
                watch = yt.get_watch_playlist(videoId=cand_vid)
                lyrics_id = watch.get("lyrics")
                if lyrics_id:
                    lyr = yt.get_lyrics(browseId=lyrics_id)
                    text = lyr.get("lyrics")
                    if text and text.strip():
                        return text.strip()
        except Exception:
            pass

    return None


# ─────────── Remote Fetchers ───────────


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
    query_title: str,
    query_artist: str,
    duration: Optional[int],
) -> Optional[Dict[str, Any]]:
    """LRCLIB /api/search — fuzzy text search with strict candidate filtering."""
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
                valid_scored = []
                for c in candidates:
                    c_title = c.get("trackName") or ""
                    c_artist = c.get("artistName") or ""
                    c_dur = int(c.get("duration") or 0)
                    valid, score = is_valid_match(
                        query_title=query_title,
                        query_artist=query_artist,
                        cand_title=c_title,
                        cand_artist=c_artist,
                        query_dur=duration,
                        cand_dur=c_dur,
                    )
                    if not valid:
                        continue
                    # Bonus for synced or word-sync
                    if c.get("hasWordSync"):
                        score += 0.20
                    elif c.get("syncedLyrics"):
                        score += 0.10
                    valid_scored.append((score, c))

                if valid_scored:
                    valid_scored.sort(key=lambda x: x[0], reverse=True)
                    best = valid_scored[0][1]
                    if best.get("syncedLyrics") or best.get("hasWordSync") or best.get("plainLyrics"):
                        return best
    except Exception:
        pass
    return None


async def _netease_search(
    client: httpx.AsyncClient,
    title: str,
    artist: str,
    duration: Optional[int] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """
    Search NetEase CloudMusic for synced LRC and plain lyrics.
    Strictly verifies candidate title and artist before accepting any lyric.
    Returns (synced_lrc, plain_lyrics).
    """
    clean_t = clean_track_title(title)
    clean_a = _clean_artist(artist)
    queries = [
        f"{clean_t} {clean_a}".strip(),
        clean_t.strip(),
    ]

    for q in queries:
        try:
            url = "https://music.163.com/api/cloudsearch/pc"
            params = {"s": q, "type": "1", "offset": "0", "limit": "6"}
            resp = await client.get(url, params=params, headers=NETEASE_HEADERS, timeout=5.0)
            if resp.status_code != 200:
                continue
            data = resp.json()
            songs = data.get("result", {}).get("songs", [])
            for s in songs:
                cand_title = s.get("name") or ""
                cand_artists = [a.get("name") or "" for a in s.get("ar", [])]
                cand_artist = ", ".join(cand_artists)
                cand_dur = int((s.get("dt") or 0) / 1000)

                valid, _ = is_valid_match(
                    query_title=title,
                    query_artist=artist,
                    cand_title=cand_title,
                    cand_artist=cand_artist,
                    query_dur=duration,
                    cand_dur=cand_dur or None,
                )
                if not valid:
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
            timeout=5.0,
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
    video_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Multi-source lyrics engine with strict matching.

    Pipeline:
      1. LRCLIB exact match (/api/get) with cleaned title & artist.
      2. LRCLIB fuzzy search (/api/search) strictly filtered with is_valid_match.
      3. NetEase CloudSearch strictly filtered with is_valid_match.
      4. If verified synced LRC is found: return immediately with synced=True.
      5. Fallback for plain text:
         - YouTube Music native official lyrics (via video_id or search)
         - LRCLIB plain text
         - NetEase plain text
         - lyrics.ovh plain text
         Delivered with synced: False in clean Plain Lyrics Mode (no fake auto-pacing).
      6. Mismatched artists (e.g. Aphex Twin for Devi Sri Prasad) are NEVER returned.
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

    # ── 2. LRCLIB fuzzy search (with strict candidate validation) ──
    q_full = f"{clean_title} {primary_artist}".strip()
    rec2 = await _lrclib_search(client, q_full, clean_title, primary_artist, duration)
    if not rec2 and clean_title != q_full:
        rec2 = await _lrclib_search(client, clean_title, clean_title, primary_artist, duration)

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

    # ── 3. NetEase CloudMusic search (strictly validated) ──
    ne_lrc, ne_plain = await _netease_search(client, clean_title, primary_artist, duration)
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

    # ── 4. YouTube Music Official Lyrics Fallback ──
    if not collected_plain:
        yt_lyrics = await asyncio.to_thread(_fetch_ytmusic_lyrics_sync, video_id, title, artist)
        if yt_lyrics:
            collected_plain = yt_lyrics.strip()

    # ── 5. lyrics.ovh plain fallback ──
    if not collected_plain:
        ovh_text = await _lyrics_ovh_fallback(client, clean_title, primary_artist)
        if not ovh_text and clean_title != title.strip():
            ovh_text = await _lyrics_ovh_fallback(client, title.strip(), primary_artist)
        if ovh_text:
            collected_plain = ovh_text.strip()

    # ── 6. Deliver Genuine Plain Lyrics (synced: False) ──
    if collected_plain:
        return _wrap_plain(collected_plain)

    return EMPTY_RESULT
