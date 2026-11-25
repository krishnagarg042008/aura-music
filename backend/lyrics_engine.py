"""
AURA Lyrics Engine — Multi-Source Synced Lyrics with Strict Candidate Verification.

Sources (checked in priority order):
  1. LRCLIB exact match   → native word-sync YAML → enhanced LRC → standard LRC
  2. LRCLIB retries       → alternate artist splits, cleaned title variants & duration-free /api/get
  3. LRCLIB fuzzy search  → strictly verified with title & alternate artist similarity
  4. NetEase CloudSearch  → strictly verified with title & alternate artist similarity
  5. YouTube Music native → official Musixmatch-backed lyrics for 100% genuine tracks
  6. lyrics.ovh           → plain text fallback

Accuracy & Sync Philosophy:
  - Genuine synced LRC (LRCLIB, NetEase) is delivered with exact line & syllable-weighted word timings.
  - Plain lyrics are delivered with synced: false and rendered in clean Plain Lyrics Mode.
    No fake auto-pacing timestamps are fabricated.
  - Candidates from different artists (e.g. Aphex Twin for Devi Sri Prasad) are strictly rejected,
    while multi-artist / composer-first credits (e.g. "Pritam, Arijit Singh") match reliably.
"""

import asyncio
import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import httpx
import yaml
from ytmusicapi import YTMusic

from backend.cache import BoundedTTLCache

LYRICS_CACHE: BoundedTTLCache[Dict[str, Any]] = BoundedTTLCache(maxsize=400, ttl=3600.0)

# ─────────── constants / headers ───────────

LRCLIB_HEADERS = {"User-Agent": "AURA-Music/2.0 (https://github.com/aura-music)"}
NETEASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Referer": "https://music.163.com/",
}

LINE_LRC_RE = re.compile(r"\[(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?\]\s*(.*)")
ENHANCED_WORD_RE = re.compile(r"<(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?>([^<]+)")

_LABEL_PATTERN = (
    r"t[\s-]*series(?:\s+(?:apna\s+punjab|bollywood\s+classics|bhakti\s+sagar|punjabi|india|music))?"
    r"|sony\s*music(?:\s+(?:india|south|entertainment|ent\.?))?"
    r"|zee\s*music(?:\s+(?:company|co\.?))?"
    r"|tips\s+(?:official|music|punjabi)"
    r"|yash\s+raj\s+films|yrf(?:\s+music)?"
    r"|saregama(?:\s+(?:music|carvaan|punjabi))?"
    r"|speed\s*records(?:\s+punjabi)?"
    r"|white\s+hill\s+music|jass\s+records|humble\s+music|geet\s+mp3"
    r"|fresh\s+media\s+records|desi\s+music\s+factory|times\s+music(?:\s+spiritual)?"
    r"|shemaroo(?:\s+filmi\s+gaane)?|ishtar\s+music|eros\s+now(?:\s+music)?"
    r"|venus(?:\s+(?:music|worldwide))?|warner\s+music\s+india|universal\s+music\s+india"
    r"|saga\s*hits|panjab\s+records|vs\s+records|brown\s+studios"
    r"|run[\s-]*up\s+records|rehaan\s+records|single\s+track\s+studio|vip\s+music"
    r"|coke\s+studio(?:\s+(?:india|pakistan|bharat))?"
)

_NOISE_KEYWORDS = (
    r"official(?:\s+(?:music\s+)?(?:video|audio|lyrical?|visuali[sz]er))?"
    r"|full\s*(?:video(?:\s*song)?|song|audio|hd|lyrical(?:\s+video)?)"
    r"|video\s*song|audio\s*song|music\s*video|visuali[sz]er"
    r"|lyrical(?:\s*video)?|lyric(?:s|\s*video)|with\s+lyrics"
    r"|title\s*track|remaster(?:ed)?|hd|4k|8k|hq|8d(?:\s*audio)?"
    r"|feat\.?|ft\.?|explicit|clean|radio\s*edit|extended|remix|jhankar(?:\s*beats)?"
    r"|live|acoustic|unplugged|reprise|slowed(?:\s*[\+&]\s*reverb)?|reverb"
    r"|sped\s*up|lofi|lo-?fi|bass\s*boosted|karaoke|instrumental"
    r"|from\s+[\"']?|ost\b|soundtrack|original\s+motion\s+picture|prod\.?\s*by"
    rf"|{_LABEL_PATTERN}"
)

BRACKET_NOISE_RE = re.compile(
    rf"""(?ix)
        (?:
            \([^()]*?\b(?:{_NOISE_KEYWORDS})\b[^()]*?\)
            |\[[^\[\]]*?\b(?:{_NOISE_KEYWORDS})\b[^\[\]]*?\]
            |【[^】]*?\b(?:{_NOISE_KEYWORDS})\b[^】]*?】
        )
    """,
)

TRAILING_LABEL_OR_TAG_RE = re.compile(
    rf"""(?ix)
        (?:\s*[-–—,/•:]+\s*|\s+)
        (?:
            {_LABEL_PATTERN}
            |official\s+(?:music\s+)?(?:video|audio|lyrical?|visuali[sz]er)
            |full\s+(?:video(?:\s+song)?|song|audio|lyrical(?:\s+video)?)
            |lyrical(?:\s+video)?|lyric\s+video|with\s+lyrics
            |video\s+song|audio\s+song|music\s+video|title\s+track
            |4k(?:\s+(?:video|song))?|hd(?:\s+(?:video|song))?|jhankar(?:\s+beats)?
            |slowed\s*[\+&]\s*reverb
        )
        \s*$
    """,
)

LABEL_ONLY_RE = re.compile(
    rf"^(?:{_LABEL_PATTERN}|youtube(?:\s+artist)?|topic|vevo|official)$",
    re.IGNORECASE,
)

# Generic keyword regex to detect pure label/tag pipe segments inside titles
PIPE_TAG_ONLY_RE = re.compile(
    rf"^(?:{_NOISE_KEYWORDS}|\s|[-–—&.,])+$",
    re.IGNORECASE,
)


# ─────────── script detection ───────────


def detect_indic_script(text: str) -> str:
    """
    Auto-detect whether text contains Devanagari (Hindi/Marathi) or Gurmukhi (Punjabi).
    Returns 'mixed', 'devanagari', 'gurmukhi', or 'latin'.
    """
    if not text:
        return "latin"
    has_deva = bool(re.search(r"[\u0900-\u097F]", text))
    has_guru = bool(re.search(r"[\u0A00-\u0A7F]", text))
    if has_deva and has_guru:
        return "mixed"
    if has_deva:
        return "devanagari"
    if has_guru:
        return "gurmukhi"
    return "latin"


def _attach_script_meta(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Attach auto-detected Indic script metadata onto a lyrics response dict."""
    if not payload or not payload.get("lines"):
        return {**payload, "script": "latin"} if payload else EMPTY_RESULT
    sample_text = payload.get("plain_text") or "\n".join(
        ln.get("text", "") for ln in payload.get("lines", [])[:30]
    )
    script = detect_indic_script(sample_text)
    return {**payload, "script": script}


# ─────────── cleaning & tokenization ───────────


def clean_track_title(title: str) -> str:
    """
    Strip YouTube-style noise, music label suffixes (T-Series, Sony Music, etc.),
    and video tags (Lyrical, Full Video) from a title so it matches lyrics databases.
    """
    first_part = title.split("|")[0].strip()
    cleaned = BRACKET_NOISE_RE.sub("", first_part)
    cleaned = re.sub(r"(?i)\s+(?:feat\.?|ft\.?)\s+.*$", "", cleaned)

    # Iteratively strip stacked trailing tags/labels (e.g. "Song - Full Video - T-Series")
    for _ in range(5):
        updated = TRAILING_LABEL_OR_TAG_RE.sub("", cleaned).strip()
        if updated == cleaned:
            break
        cleaned = updated

    cleaned = re.sub(r"\(\s*\)|\[\s*\]", "", cleaned)
    cleaned = re.sub(r"\s*[-–—:,/•]+\s*$", "", cleaned).strip()
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned or title.strip()


def _is_generic_or_label_artist(artist: str) -> bool:
    cleaned = re.sub(r"[^a-zA-Z0-9\s-]", " ", artist or "").strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned:
        return True
    return bool(LABEL_ONLY_RE.fullmatch(cleaned))


def _clean_single_artist(name: str) -> str:
    """Clean one individual artist token (strip '- Topic', '(Official)', etc.)."""
    s = re.sub(r"(?i)\s*[-–—]\s*topic\s*$", "", name or "")
    s = re.sub(r"(?i)\s*(?:\(|\[)?(?:official|vevo|music\s*channel)(?:\)|\])?\s*$", "", s)
    s = re.sub(r"\s+", " ", s).strip(" ,;-–—/|")
    return s


def _clean_artist(artist: str) -> str:
    """Return the primary non-label artist name, stripped of features / collaborators."""
    candidates = _split_artist_candidates(artist)
    if candidates:
        return candidates[0]
    primary = re.split(r"[,&x×/;•]|\bfeat\.?\b|\bft\.?\b|\bwith\b|\band\b", artist, flags=re.IGNORECASE)[0]
    return _clean_single_artist(primary) or artist.strip()


def _extract_title_artist_hints(title: str) -> List[str]:
    """Extract optional non-label artist/movie hints from pipe or dash segments of a YouTube title."""
    seen = set()
    hints: List[str] = []
    raw_segments = [seg.strip() for seg in re.split(r"[|]", title or "") if seg.strip()]
    if len(raw_segments) > 1:
        for seg in raw_segments[1:]:
            if PIPE_TAG_ONLY_RE.match(seg):
                continue
            for sub in re.split(r"[,;&×/•]|\s+[-–—]\s+", seg):
                cleaned = _clean_single_artist(sub)
                if not cleaned or _is_generic_or_label_artist(cleaned):
                    continue
                k = cleaned.lower()
                if k not in seen:
                    seen.add(k)
                    hints.append(cleaned)
    return hints


def _split_artist_candidates(artist: str, title: str = "") -> List[str]:
    """
    Generate clean alternate artist splits for Bollywood/Punjabi/collaborative tracks.
    Handles comma/semicolon/ampersand/feat splits, YouTube '- Topic', '(DSP)' acronyms,
    and filters out record labels (T-Series, Sony Music).
    """
    seen = set()
    candidates: List[str] = []

    def _add(raw_name: str) -> None:
        cleaned = _clean_single_artist(raw_name)
        if not cleaned or _is_generic_or_label_artist(cleaned):
            return
        # Strip trailing parenthetical acronym like "DEVI SRI PRASAD (DSP)" while adding both
        paren_m = re.match(r"^(.*?)\s*\(([^()]{2,20})\)\s*$", cleaned)
        if paren_m:
            base_part = paren_m.group(1).strip()
            inner_part = paren_m.group(2).strip()
            for part in (base_part, inner_part):
                if part and not _is_generic_or_label_artist(part):
                    k = part.lower()
                    if k not in seen:
                        seen.add(k)
                        candidates.append(part)
            return

        k = cleaned.lower()
        if k not in seen:
            seen.add(k)
            candidates.append(cleaned)

    if artist:
        parts = re.split(
            r"[,;&×/•]|\s+x\s+|\s+[-–—]\s+|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b|\band\b|\bvs\.?\b",
            artist,
            flags=re.IGNORECASE,
        )
        for p in parts:
            _add(p)

    return candidates


def _generate_title_candidates(title: str, artist: str = "") -> List[str]:
    """
    Produce ordered deduplicated title candidates from a raw YouTube / YT Music title.
    Handles 'Song - Movie', 'Artist - Song', and trailing subtitle parentheticals.
    """
    seen = set()
    out: List[str] = []

    def _add(t: str) -> None:
        val = re.sub(r"\s{2,}", " ", (t or "").strip())
        if not val:
            return
        key = val.lower()
        if key not in seen:
            seen.add(key)
            out.append(val)

    cleaned = clean_track_title(title)
    _add(cleaned)

    # Handle "Artist - Song" vs "Song - Movie" separated by spaced dashes
    dash_parts = [p.strip() for p in re.split(r"\s+[-–—]\s+", cleaned) if p.strip()]
    if len(dash_parts) >= 2:
        left = dash_parts[0]
        right = dash_parts[1]
        artist_splits = _split_artist_candidates(artist)
        left_tokens = _tokenize(left)
        left_is_artist = any(
            left_tokens and _tokenize(a) and (
                len(left_tokens & _tokenize(a)) >= min(len(left_tokens), len(_tokenize(a)))
                or _normalize_text(left) in _normalize_text(a)
            )
            for a in artist_splits
        )
        if left_is_artist:
            _add(right)
        else:
            _add(left)

    # Strip non-noise parentheticals as secondary fallback (e.g. "Do Gallan (Let's Talk)" -> "Do Gallan")
    no_parens = re.sub(r"\s*(?:\([^()]*\)|\[[^\[\]]*\])\s*", " ", cleaned).strip()
    if no_parens and len(no_parens) >= 2:
        _add(no_parens)

    first_pipe = title.split("|")[0].strip()
    if first_pipe != cleaned and len(first_pipe) <= 72:
        _add(first_pipe)

    return out[:4]


def _parse_ts(m: str, s: str, frac: Optional[str]) -> float:
    minutes = int(m)
    seconds = int(s)
    if not frac:
        return minutes * 60 + seconds
    return minutes * 60 + seconds + (int(frac) / (1000.0 if len(frac) == 3 else 100.0))


def _strip_latin_diacritics(text: str) -> str:
    """Fold Latin diacritics (e.g. É -> E) while preserving non-Latin combining marks (Indic matras, etc.)."""
    out: List[str] = []
    last_is_latin = False
    for ch in unicodedata.normalize("NFD", text):
        cat = unicodedata.category(ch)
        if cat == "Mn" and last_is_latin:
            continue
        out.append(ch)
        if cat != "Mn":
            last_is_latin = ord(ch) < 0x0250 and ch.isalpha()
    return unicodedata.normalize("NFKC", "".join(out))


def _normalize_text(text: str) -> str:
    folded = _strip_latin_diacritics(text).lower()
    cleaned_chars = [
        " " if unicodedata.category(ch)[0] in ("P", "S", "Z", "C") else ch
        for ch in folded
    ]
    return re.sub(r"\s+", " ", "".join(cleaned_chars)).strip()


def _tokenize(text: str) -> set:
    norm = _normalize_text(text)
    parts = norm.split()
    if not parts:
        return set()
    # Keep multi-char tokens and all non-ASCII words; fall back to all parts for single-char titles like "U"
    filtered = {w for w in parts if len(w) > 1 or any(ord(c) > 127 for c in w)}
    return filtered or set(parts)


# ─────────── strict candidate validation ───────────


def is_valid_match(
    query_title: str,
    query_artist: str,
    cand_title: str,
    cand_artist: str,
    query_dur: Optional[int] = None,
    cand_dur: Optional[int] = None,
    artist_candidates: Optional[List[str]] = None,
    title_candidates: Optional[List[str]] = None,
) -> Tuple[bool, float]:
    """
    Strictly validate whether a candidate match is genuine.
    Returns (is_valid, relevance_score).

    - Checks title match against cleaned title & alternate title candidates.
    - Checks candidate artist (including its splits) against ALL non-label artist splits
      from query_artist so composer-first credits (e.g. "Pritam, Arijit Singh") match cleanly
      while totally different artists (e.g. Aphex Twin vs Devi Sri Prasad) are rejected.
    """
    cand_t_clean = clean_track_title(cand_title)
    c_t_tokens = _tokenize(cand_t_clean)
    norm_c_title = _normalize_text(cand_t_clean)

    t_list = title_candidates or _generate_title_candidates(query_title, query_artist)
    if not t_list:
        t_list = [clean_track_title(query_title)]

    best_title_score = 0.0
    title_ok = False
    for q_t in t_list:
        q_t_tokens = _tokenize(q_t)
        norm_q = _normalize_text(q_t)
        if not q_t_tokens:
            title_ok = True
            best_title_score = max(best_title_score, 1.0)
            continue

        overlap = len(q_t_tokens & c_t_tokens)
        score = overlap / max(len(q_t_tokens), 1)
        ok = (
            (overlap >= min(2, len(q_t_tokens)))
            or (score >= 0.5)
            or (bool(norm_q) and norm_q in norm_c_title)
            or (bool(norm_c_title) and norm_c_title in norm_q)
        )
        if ok:
            title_ok = True
            best_title_score = max(best_title_score, score if score > 0 else 0.75)

    if not title_ok:
        return False, 0.0

    # 2. Artist matching check across alternate artist splits
    q_artists = artist_candidates if artist_candidates is not None else _split_artist_candidates(query_artist, query_title)
    c_artists = _split_artist_candidates(cand_artist)
    if not c_artists and cand_artist.strip():
        c_artists = [cand_artist.strip()]

    if q_artists and c_artists:
        best_artist_score = 0.0
        any_artist_match = False

        for qa in q_artists:
            q_a_tokens = _tokenize(qa)
            norm_qa = _normalize_text(qa)
            for ca in c_artists:
                c_a_tokens = _tokenize(ca)
                norm_ca = _normalize_text(ca)
                if not q_a_tokens or not c_a_tokens:
                    continue
                a_overlap = len(q_a_tokens & c_a_tokens)
                substring_hit = bool(norm_qa and norm_ca and (norm_qa in norm_ca or norm_ca in norm_qa))
                if a_overlap > 0 or substring_hit:
                    any_artist_match = True
                    s = max(
                        a_overlap / max(len(q_a_tokens), 1),
                        0.7 if substring_hit else 0.0,
                    )
                    best_artist_score = max(best_artist_score, s)

        if not any_artist_match:
            return False, 0.0
        artist_score = best_artist_score
    else:
        artist_score = 0.5

    # 3. Duration matching check (if available)
    dur_score = 1.0
    if query_dur and cand_dur and query_dur > 0 and cand_dur > 0:
        diff = abs(query_dur - cand_dur)
        if diff > 60:
            return False, 0.0
        dur_score = max(0.0, 1.0 - (diff / 60.0))

    total_score = (best_title_score * 0.50) + (artist_score * 0.35) + (dur_score * 0.15)
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
        if start < 3.0 and re.match(
            r"^(作词|作曲|制作|编曲|混音|母带|producer|lyricist|lyrics|artist|album|composer|arranger|by|encoded|offset|ti|ar|al)\s*[:：]",
            body,
            re.I,
        ):
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
    return _attach_script_meta({
        "synced": False,
        "word_native": False,
        "smart_sync": False,
        "plain_text": plain_text.strip(),
        "lines": lines,
    })


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

    # 2. Try searching YouTube Music with cleaned title and alternate artist splits
    clean_title = clean_track_title(title)
    artist_splits = _split_artist_candidates(artist, title)
    queries = [f"{clean_title} {a}".strip() for a in artist_splits[:2]] or [clean_title]

    for q in queries:
        if not q:
            continue
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
    if not title or not artist:
        return None
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
    artist_candidates: Optional[List[str]] = None,
    title_candidates: Optional[List[str]] = None,
) -> Optional[Dict[str, Any]]:
    """LRCLIB /api/search — fuzzy text search with strict candidate filtering."""
    if not query:
        return None
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
                        artist_candidates=artist_candidates,
                        title_candidates=title_candidates,
                    )
                    if not valid:
                        continue
                    # Strongly prefer native word-sync and synced LRC over plain lyrics
                    if c.get("hasWordSync"):
                        score += 0.35
                    elif c.get("syncedLyrics"):
                        score += 0.25
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
    artist_candidates: Optional[List[str]] = None,
    title_candidates: Optional[List[str]] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """
    Search NetEase CloudMusic for synced LRC and plain lyrics.
    Strictly verifies candidate title and artist before accepting any lyric.
    Returns (synced_lrc, plain_lyrics).
    """
    clean_t = clean_track_title(title)
    a_splits = artist_candidates if artist_candidates is not None else _split_artist_candidates(artist, title)
    clean_a = a_splits[0] if a_splits else _clean_artist(artist)

    queries = []
    if clean_a:
        queries.append(f"{clean_t} {clean_a}".strip())
    if len(a_splits) > 1:
        queries.append(f"{clean_t} {a_splits[1]}".strip())
    queries.append(clean_t.strip())

    # Deduplicate queries preserving order
    dedup_queries = list(dict.fromkeys(q for q in queries if q))

    for q in dedup_queries:
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
                    artist_candidates=a_splits,
                    title_candidates=title_candidates,
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
        safe_artist = quote(artist.replace("/", " ").strip(), safe="")
        safe_title = quote(title.replace("/", " ").strip(), safe="")
        if not safe_artist or not safe_title:
            return ""
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
    "script": "latin",
    "lines": [],
}


def _extract_lrclib_synced(rec: Optional[Dict[str, Any]], duration: Optional[int]) -> Optional[Dict[str, Any]]:
    if not rec:
        return None
    if rec.get("hasWordSync") and rec.get("lyricsfile"):
        y_lines = parse_lyricsfile_yaml(rec["lyricsfile"])
        if y_lines:
            plain = rec.get("plainLyrics") or ""
            return _attach_script_meta({
                "synced": True,
                "word_native": True,
                "smart_sync": False,
                "plain_text": plain,
                "lines": y_lines,
            })
    if rec.get("syncedLyrics"):
        l_lines = parse_lrc(rec["syncedLyrics"], float(duration or 240))
        if l_lines:
            is_native = "<" in rec["syncedLyrics"] and ">" in rec["syncedLyrics"]
            plain = rec.get("plainLyrics") or ""
            return _attach_script_meta({
                "synced": True,
                "word_native": is_native,
                "smart_sync": False,
                "plain_text": plain,
                "lines": l_lines,
            })
    return None


async def fetch_synced_lyrics(
    client: httpx.AsyncClient,
    title: str,
    artist: str,
    duration: Optional[int] = None,
    video_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Multi-source lyrics engine with label-aware sanitization, alternate artist retries,
    strict candidate validation, and caching.

    Pipeline:
      1. Primary LRCLIB exact match (/api/get) with cleaned title & primary artist.
      2. Concurrent LRCLIB retries across alternate artist splits, cleaned title variants,
         and duration-free /api/get (bypasses music video intro/outro duration drift),
         plus strictly verified LRCLIB /api/search and NetEase CloudSearch.
      3. Return verified synced LRC immediately with Indic script detection.
      4. Fallback for plain text:
         - YouTube Music native official lyrics (via video_id or search)
         - LRCLIB / NetEase / lyrics.ovh plain text
         Delivered with synced: False in clean Plain Lyrics Mode (no fake auto-pacing).
    """
    title_candidates = _generate_title_candidates(title, artist)
    clean_title = title_candidates[0] if title_candidates else clean_track_title(title)
    artist_splits = _split_artist_candidates(artist)
    title_hints = _extract_title_artist_hints(title) if not artist_splits else []
    query_artists = artist_splits or title_hints
    primary_artist = query_artists[0] if query_artists else ""

    cache_key = (video_id or "", clean_title.lower(), primary_artist.lower(), int(duration or 0))
    cached = LYRICS_CACHE.get(cache_key)
    if cached is not None:
        return cached

    collected_plain: str = ""

    # ── 1. Fast Primary LRCLIB exact match (single fast-path request when possible) ──
    if primary_artist:
        primary_rec = await _lrclib_exact(client, clean_title, primary_artist, duration)
        if isinstance(primary_rec, dict):
            parsed = _extract_lrclib_synced(primary_rec, duration)
            if parsed:
                LYRICS_CACHE.set(cache_key, parsed)
                return parsed
            if primary_rec.get("plainLyrics"):
                collected_plain = primary_rec["plainLyrics"].strip()

    # ── 2. Retry LRCLIB with alternate artist splits, title variants & duration-free exact + concurrent search ──
    retry_tasks: List[Any] = []
    exact_seen = {(clean_title.lower(), primary_artist.lower(), bool(duration and duration > 0))}

    def _queue_exact(t_q: str, a_q: str, dur_q: Optional[int]) -> None:
        if not t_q or not a_q:
            return
        sig = (t_q.lower(), a_q.lower(), bool(dur_q and dur_q > 0))
        if sig in exact_seen:
            return
        exact_seen.add(sig)
        retry_tasks.append(_lrclib_exact(client, t_q, a_q, dur_q))

    # Alternate artist splits (e.g. composer-first "Pritam, Arijit Singh" -> "Arijit Singh")
    for alt_a in query_artists[1:5]:
        _queue_exact(clean_title, alt_a, duration)

    # Alternate title variants (e.g. "Apna Bana Le - Bhediya" -> "Apna Bana Le", raw title)
    for alt_t in title_candidates[1:3]:
        if primary_artist:
            _queue_exact(alt_t, primary_artist, duration)

    # Retry LRCLIB exact WITHOUT duration constraint (MV intro/outro often offsets YouTube duration by 5-25s)
    if duration and duration > 0:
        for a_q in query_artists[:4]:
            _queue_exact(clean_title, a_q, None)

    # Concurrent LRCLIB fuzzy searches across title variants & alternate artists
    search_queries: List[str] = []
    for a_q in query_artists[:3]:
        search_queries.append(f"{clean_title} {a_q}".strip())
    for t_q in title_candidates[:2]:
        search_queries.append(t_q)

    dedup_search_q = list(dict.fromkeys(q for q in search_queries if q))
    search_tasks = [
        _lrclib_search(
            client,
            sq,
            clean_title,
            primary_artist or artist,
            duration,
            artist_candidates=artist_splits,
            title_candidates=title_candidates,
        )
        for sq in dedup_search_q[:4]
    ]

    netease_task = _netease_search(
        client,
        clean_title,
        primary_artist or artist,
        duration,
        artist_candidates=artist_splits,
        title_candidates=title_candidates,
    )

    all_phase2 = await asyncio.gather(*retry_tasks, *search_tasks, netease_task, return_exceptions=True)
    n_exact = len(retry_tasks)
    exact_retry_results = all_phase2[:n_exact]
    search_results = all_phase2[n_exact:-1]
    netease_res = all_phase2[-1]

    # Prefer synced LRCLIB exact retries first (verify duration if duration-free hit returns)
    for rec in exact_retry_results:
        if isinstance(rec, dict):
            # Guard duration-free exact hits against huge duration mismatches (> 60s)
            cand_dur = int(rec.get("duration") or 0)
            if duration and cand_dur and abs(duration - cand_dur) > 60:
                continue
            parsed = _extract_lrclib_synced(rec, duration)
            if parsed:
                LYRICS_CACHE.set(cache_key, parsed)
                return parsed
            if not collected_plain and rec.get("plainLyrics"):
                collected_plain = rec["plainLyrics"].strip()

    # Check strictly validated LRCLIB fuzzy search results
    for rec2 in search_results:
        if isinstance(rec2, dict):
            parsed = _extract_lrclib_synced(rec2, duration)
            if parsed:
                LYRICS_CACHE.set(cache_key, parsed)
                return parsed
            if not collected_plain and rec2.get("plainLyrics"):
                collected_plain = rec2["plainLyrics"].strip()

    # Check NetEase synced / plain
    if isinstance(netease_res, tuple) and len(netease_res) == 2:
        ne_lrc, ne_plain = netease_res
        if ne_lrc:
            l_lines = parse_lrc(ne_lrc, float(duration or 240))
            if l_lines:
                res = _attach_script_meta({
                    "synced": True,
                    "word_native": False,
                    "smart_sync": False,
                    "plain_text": collected_plain or "",
                    "lines": l_lines,
                })
                LYRICS_CACHE.set(cache_key, res)
                return res
        if not collected_plain and ne_plain:
            collected_plain = ne_plain.strip()

    # ── 3. YouTube Music Official Lyrics Fallback ──
    if not collected_plain:
        yt_lyrics = await asyncio.to_thread(_fetch_ytmusic_lyrics_sync, video_id, title, artist)
        if yt_lyrics:
            collected_plain = yt_lyrics.strip()

    # ── 4. lyrics.ovh plain fallback (try cleaned title + primary/alternate artist) ──
    if not collected_plain:
        for t_q in title_candidates[:2]:
            for a_q in (artist_splits[:2] or [artist]):
                if not a_q:
                    continue
                ovh_text = await _lyrics_ovh_fallback(client, t_q, a_q)
                if ovh_text:
                    collected_plain = ovh_text.strip()
                    break
            if collected_plain:
                break

    # ── 5. Deliver Genuine Plain Lyrics (synced: False) ──
    if collected_plain:
        wrapped = _wrap_plain(collected_plain)
        LYRICS_CACHE.set(cache_key, wrapped)
        return wrapped

    LYRICS_CACHE.set(cache_key, EMPTY_RESULT, ttl=300.0)
    return EMPTY_RESULT
