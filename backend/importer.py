"""
AURA External Link Importer — Zero-config Spotify & Apple Music URL resolver.

Resolves public track, album, and playlist URLs (including Spotify URIs and
short links) into structured track metadata and matches each track cleanly on
YouTube Music with concurrent bounded search and strict candidate scoring.
"""

from __future__ import annotations

import asyncio
import html as html_lib
import ipaddress
import json
import re
from html.parser import HTMLParser
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import ParseResult, parse_qs, urljoin, urlparse

import httpx

from backend.cache import BoundedTTLCache
from backend.lyrics_engine import (
    _normalize_text,
    _split_artist_candidates,
    _tokenize,
    clean_track_title,
    is_valid_match,
)

MAX_IMPORT_TRACKS = 100
IMPORT_CACHE: BoundedTTLCache[Dict[str, Any]] = BoundedTTLCache(maxsize=64, ttl=900.0)

SPOTIFY_DIRECT_HOSTS = {"open.spotify.com", "play.spotify.com"}
SPOTIFY_SHORT_HOSTS = {"spotify.link", "spotify.app.link", "spoti.fi"}
APPLE_DIRECT_HOSTS = {
    "music.apple.com",
    "geo.music.apple.com",
    "itunes.apple.com",
    "geo.itunes.apple.com",
}
APPLE_SHORT_HOSTS = {"apple.co"}
ALL_ALLOWED_HOSTS = SPOTIFY_DIRECT_HOSTS | SPOTIFY_SHORT_HOSTS | APPLE_DIRECT_HOSTS | APPLE_SHORT_HOSTS

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

SPOTIFY_ID_RE = re.compile(r"^[A-Za-z0-9]{10,40}$")
APPLE_PLAYLIST_ID_RE = re.compile(r"^pl\.[A-Za-z0-9._-]{4,80}$")
APPLE_NUMERIC_ID_RE = re.compile(r"^\d{5,20}$")
COUNTRY_CODE_RE = re.compile(r"^[a-z]{2}$")

UNWANTED_VERSION_MODIFIERS = (
    "slowed",
    "reverb",
    "nightcore",
    "8d",
    "sped up",
    "karaoke",
    "instrumental",
    "cover",
    "tribute",
    "1 hour",
    "loop",
    "lullaby",
    "ringtone",
)

SOFT_VERSION_MODIFIERS = (
    "remix",
    "mashup",
    "lofi",
    "lo-fi",
    "unplugged",
)

_SCHEMELESS_EXTERNAL_RE = re.compile(
    r"^(?:(?:open|play)\.spotify\.com|spotify\.link|spotify\.app\.link|spoti\.fi|"
    r"(?:geo\.)?(?:music|itunes)\.apple\.com|apple\.co)/",
    re.I,
)


class _MetaAndScriptParser(HTMLParser):
    """Lightweight stdlib HTML parser for <title>, <meta>, and embedded JSON scripts."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: Dict[str, str] = {}
        self.title: str = ""
        self.scripts: Dict[str, str] = {}
        self._in_title = False
        self._title_parts: List[str] = []
        self._active_script_id: Optional[str] = None
        self._script_parts: List[str] = []

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        tag_l = tag.lower()
        attr_map = {k.lower(): (v or "") for k, v in attrs}
        if tag_l == "meta":
            key = (attr_map.get("property") or attr_map.get("name") or "").strip().lower()
            val = attr_map.get("content", "").strip()
            if key and val and key not in self.meta:
                self.meta[key] = val
        elif tag_l == "title":
            self._in_title = True
            self._title_parts = []
        elif tag_l == "script":
            sid = attr_map.get("id", "").strip()
            if sid in ("__NEXT_DATA__", "serialized-server-data"):
                self._active_script_id = sid
                self._script_parts = []

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_parts.append(data)
        elif self._active_script_id:
            self._script_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag_l = tag.lower()
        if tag_l == "title" and self._in_title:
            self._in_title = False
            self.title = "".join(self._title_parts).strip()
        elif tag_l == "script" and self._active_script_id:
            self.scripts[self._active_script_id] = "".join(self._script_parts).strip()
            self._active_script_id = None
            self._script_parts = []


def _clean_space(text: str) -> str:
    if not text:
        return ""
    unescaped = html_lib.unescape(str(text)).replace("\xa0", " ")
    return re.sub(r"\s+", " ", unescaped).strip()


def _is_safe_host(host: str, allowed_hosts: set[str]) -> bool:
    if not host:
        return False
    h = host.lower().rstrip(".")
    if h in ("localhost", "localhost.localdomain"):
        return False
    try:
        ipaddress.ip_address(h)
        return False
    except ValueError:
        pass
    return h in allowed_hosts


def _validate_https_url(url: str, allowed_hosts: set[str]) -> ParseResult:
    parsed = urlparse((url or "").strip())
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise ValueError("URL must use https:// from Spotify or Apple Music.")
    if not _is_safe_host(parsed.hostname, allowed_hosts):
        raise ValueError("Unsupported host. Only Spotify and Apple Music links are allowed.")
    return parsed


def _normalize_external_raw(raw_url: str) -> str:
    raw = (raw_url or "").strip()
    if raw.lower().startswith("http://"):
        raw = "https://" + raw[7:]
    elif _SCHEMELESS_EXTERNAL_RE.match(raw):
        raw = "https://" + raw
    return raw


def is_external_music_url(raw_url: str) -> bool:
    """Return True if raw_url looks like a Spotify or Apple Music link or URI."""
    raw = (raw_url or "").strip()
    if raw.lower().startswith(("spotify:track:", "spotify:album:", "spotify:playlist:")):
        return True
    normalized = _normalize_external_raw(raw)
    try:
        parsed = urlparse(normalized)
        host = (parsed.hostname or "").lower().rstrip(".")
        return parsed.scheme.lower() == "https" and _is_safe_host(host, ALL_ALLOWED_HOSTS)
    except Exception:
        return False


def parse_external_url(raw_url: str) -> Dict[str, Any]:
    """
    Validate and classify a Spotify or Apple Music URL/URI.
    Raises ValueError with an actionable message if unsupported or unsafe.
    """
    raw = (raw_url or "").strip()
    if not raw:
        raise ValueError("Please provide a Spotify or Apple Music URL.")

    # Handle spotify:<kind>:<id> URIs directly (case-insensitive prefix)
    uri_match = re.fullmatch(r"spotify:(track|album|playlist):([A-Za-z0-9]{10,40})", raw, flags=re.I)
    if uri_match:
        kind, item_id = uri_match.group(1).lower(), uri_match.group(2)
        return {
            "provider": "spotify",
            "kind": kind,
            "item_id": item_id,
            "album_id": None,
            "country": "us",
            "canonical_url": f"https://open.spotify.com/{kind}/{item_id}",
        }

    raw = _normalize_external_raw(raw)

    parsed = _validate_https_url(raw, ALL_ALLOWED_HOSTS)
    host = (parsed.hostname or "").lower().rstrip(".")
    segments = [s for s in parsed.path.split("/") if s]

    # Short redirect links (require controlled resolution)
    if host in SPOTIFY_SHORT_HOSTS:
        return {
            "provider": "spotify",
            "kind": "shortlink",
            "item_id": "",
            "album_id": None,
            "country": "us",
            "canonical_url": parsed.geturl(),
        }
    if host in APPLE_SHORT_HOSTS:
        return {
            "provider": "apple",
            "kind": "shortlink",
            "item_id": "",
            "album_id": None,
            "country": "us",
            "canonical_url": parsed.geturl(),
        }

    # Standard Spotify URLs
    if host in SPOTIFY_DIRECT_HOSTS:
        if segments and segments[0].startswith("intl-"):
            segments = segments[1:]
        if segments and segments[0] == "embed":
            segments = segments[1:]
        if len(segments) >= 2 and segments[0] in ("track", "album", "playlist"):
            kind, item_id = segments[0], segments[1]
            if not SPOTIFY_ID_RE.fullmatch(item_id):
                raise ValueError("Invalid Spotify ID in URL.")
            return {
                "provider": "spotify",
                "kind": kind,
                "item_id": item_id,
                "album_id": None,
                "country": "us",
                "canonical_url": f"https://open.spotify.com/{kind}/{item_id}",
            }
        raise ValueError("Only Spotify track, album, and playlist links are supported.")

    # Apple Music URLs
    if host in APPLE_DIRECT_HOSTS:
        if "library" in segments:
            raise ValueError("Private Apple Music library links cannot be accessed. Share a public link instead.")

        country = "us"
        if segments and COUNTRY_CODE_RE.fullmatch(segments[0].lower()):
            country = segments[0].lower()
            segments = segments[1:]

        if not segments:
            raise ValueError("Invalid Apple Music URL.")

        kind_seg = segments[0].lower()
        tail_id = segments[-1]
        qs = parse_qs(parsed.query)
        qs_track_id = (qs.get("i") or [None])[0]

        if kind_seg == "album" and APPLE_NUMERIC_ID_RE.fullmatch(tail_id):
            if qs_track_id and APPLE_NUMERIC_ID_RE.fullmatch(qs_track_id):
                return {
                    "provider": "apple",
                    "kind": "track",
                    "item_id": qs_track_id,
                    "album_id": tail_id,
                    "country": country,
                    "canonical_url": f"https://music.apple.com/{country}/album/{tail_id}?i={qs_track_id}",
                }
            return {
                "provider": "apple",
                "kind": "album",
                "item_id": tail_id,
                "album_id": tail_id,
                "country": country,
                "canonical_url": f"https://music.apple.com/{country}/album/{tail_id}",
            }

        if kind_seg in ("song", "music-video") and APPLE_NUMERIC_ID_RE.fullmatch(tail_id):
            return {
                "provider": "apple",
                "kind": "track",
                "item_id": tail_id,
                "album_id": None,
                "country": country,
                "canonical_url": f"https://music.apple.com/{country}/{kind_seg}/{tail_id}",
            }

        if kind_seg == "playlist" and APPLE_PLAYLIST_ID_RE.fullmatch(tail_id):
            return {
                "provider": "apple",
                "kind": "playlist",
                "item_id": tail_id,
                "album_id": None,
                "country": country,
                "canonical_url": f"https://music.apple.com/{country}/playlist/{tail_id}",
            }

        raise ValueError("Only Apple Music song, album, and playlist links are supported.")

    raise ValueError("Unsupported URL.")


async def _resolve_short_link(
    client: httpx.AsyncClient,
    url: str,
    allowed_hosts: set[str],
) -> str:
    """Safely resolve a short link step-by-step while enforcing strict host allowlists."""
    current = url
    for _ in range(4):
        _validate_https_url(current, allowed_hosts)
        resp = await client.get(current, headers=BROWSER_HEADERS, follow_redirects=False, timeout=10.0)
        if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("location"):
            next_url = urljoin(current, resp.headers["location"])
            _validate_https_url(next_url, allowed_hosts)
            current = next_url
            continue
        return str(resp.url or current)
    return current


def _parse_html(html_text: str) -> _MetaAndScriptParser:
    parser = _MetaAndScriptParser()
    parser.feed(html_text)
    parser.close()
    return parser


def _parse_spotify_embed_entity(entity: Dict[str, Any], expected_kind: str) -> Optional[Dict[str, Any]]:
    if not isinstance(entity, dict) or not entity:
        return None

    title = _clean_space(entity.get("title") or entity.get("name") or "")

    if expected_kind == "track":
        if not title:
            return None
        artists_raw = entity.get("artists") or []
        artist = ", ".join(
            _clean_space(a.get("name", ""))
            for a in artists_raw
            if isinstance(a, dict) and a.get("name")
        )
        if not artist:
            artist = _clean_space(entity.get("subtitle") or "")
        duration = round((entity.get("duration") or 0) / 1000)
        return {
            "provider": "spotify",
            "kind": "track",
            "title": title,
            "total_source_tracks": 1,
            "source_tracks": [{"title": title, "artist": artist, "duration": duration}],
        }

    header_artist = _clean_space(entity.get("subtitle") or "")
    if not header_artist and isinstance(entity.get("artists"), list):
        header_artist = ", ".join(
            _clean_space(a.get("name", ""))
            for a in entity["artists"]
            if isinstance(a, dict) and a.get("name")
        )

    track_list = entity.get("trackList") or []
    tracks: List[Dict[str, Any]] = []
    for item in track_list[:MAX_IMPORT_TRACKS]:
        if not isinstance(item, dict):
            continue
        t_title = _clean_space(item.get("title") or item.get("name") or "")
        artists_item = item.get("artists")
        if isinstance(artists_item, list) and artists_item:
            t_artist = ", ".join(
                _clean_space(a.get("name", ""))
                for a in artists_item
                if isinstance(a, dict) and a.get("name")
            )
        else:
            t_artist = ""
        if not t_artist:
            t_artist = _clean_space(item.get("subtitle") or "")
        if not t_artist and expected_kind == "album":
            t_artist = header_artist
        if not t_title:
            continue
        t_dur = round((item.get("duration") or 0) / 1000)
        tracks.append({"title": t_title, "artist": t_artist, "duration": t_dur})

    if not tracks:
        return None

    return {
        "provider": "spotify",
        "kind": expected_kind,
        "title": title or f"Spotify {expected_kind.title()}",
        "total_source_tracks": len(track_list),
        "source_tracks": tracks,
    }


async def _fetch_spotify_source(client: httpx.AsyncClient, parsed: Dict[str, Any]) -> Dict[str, Any]:
    kind = parsed["kind"]
    item_id = parsed["item_id"]

    # Primary: Spotify embed page embeds clean Next.js JSON payload with full trackList / artists
    embed_url = f"https://open.spotify.com/embed/{kind}/{item_id}"
    try:
        resp = await client.get(embed_url, headers=BROWSER_HEADERS, timeout=12.0)
        if resp.status_code == 200:
            doc = _parse_html(resp.text)
            raw_next = doc.scripts.get("__NEXT_DATA__", "")
            if raw_next:
                next_data = json.loads(raw_next)
                entity = (
                    next_data.get("props", {})
                    .get("pageProps", {})
                    .get("state", {})
                    .get("data", {})
                    .get("entity", {})
                )
                extracted = _parse_spotify_embed_entity(entity, kind)
                if extracted:
                    return extracted
    except Exception:
        pass

    # Fallback for single track: scrape main Spotify page meta tags / title & oEmbed
    if kind == "track":
        try:
            page_resp = await client.get(parsed["canonical_url"], headers=BROWSER_HEADERS, timeout=10.0)
            if page_resp.status_code == 200:
                doc = _parse_html(page_resp.text)
                og_title = _clean_space(doc.meta.get("og:title", ""))
                og_desc = _clean_space(doc.meta.get("og:description", ""))
                artist = ""
                m_title = re.match(r"^(.*?)\s*-\s*song(?:\s+and\s+lyrics)?\s+by\s+(.*?)\s*\|\s*Spotify$", doc.title, re.I)
                if m_title:
                    og_title = og_title or _clean_space(m_title.group(1))
                    artist = _clean_space(m_title.group(2))
                elif "·" in og_desc:
                    artist = _clean_space(og_desc.split("·")[0])
                if og_title:
                    return {
                        "provider": "spotify",
                        "kind": "track",
                        "title": og_title,
                        "total_source_tracks": 1,
                        "source_tracks": [{"title": og_title, "artist": artist, "duration": 0}],
                    }
        except Exception:
            pass

    raise ValueError("Could not read that Spotify link. Make sure it exists and is set to Public.")


def _itunes_item_to_track(item: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "title": _clean_space(item.get("trackName") or ""),
        "artist": _clean_space(item.get("artistName") or ""),
        "duration": round((item.get("trackTimeMillis") or 0) / 1000),
        "album": _clean_space(item.get("collectionName") or ""),
    }


def _extract_apple_sections(sd: Any) -> List[Dict[str, Any]]:
    """Extract section dicts from Apple Music serialized-server-data (supports both list and dict roots)."""
    entries = sd if isinstance(sd, list) else sd.get("data") if isinstance(sd, dict) else []
    if not isinstance(entries, list):
        entries = []

    sections: List[Dict[str, Any]] = []
    if isinstance(sd, dict) and isinstance(sd.get("sections"), list):
        sections.extend(s for s in sd["sections"] if isinstance(s, dict))

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        inner = entry.get("data")
        if isinstance(inner, dict) and isinstance(inner.get("sections"), list):
            sections.extend(s for s in inner["sections"] if isinstance(s, dict))
        elif isinstance(entry.get("sections"), list):
            sections.extend(s for s in entry["sections"] if isinstance(s, dict))
    return sections


def _extract_apple_serialized_tracks(html_text: str, target_track_id: Optional[str] = None) -> Tuple[str, List[Dict[str, Any]]]:
    doc = _parse_html(html_text)
    raw_sd = doc.scripts.get("serialized-server-data", "")
    title = ""
    header_artist = ""
    tracks: List[Dict[str, Any]] = []

    if raw_sd:
        try:
            sd = json.loads(raw_sd)
            sections = _extract_apple_sections(sd)
            for sec in sections:
                kind = sec.get("itemKind", "")
                sec_id = str(sec.get("id", ""))
                items = sec.get("items") or []

                if kind in ("containerDetailHeaderLockup", "playlistHeaderLockup") and items and not title:
                    title = _clean_space(items[0].get("title") or "")
                    if isinstance(items[0].get("subtitleLinks"), list):
                        header_artist = ", ".join(
                            _clean_space(s.get("title", ""))
                            for s in items[0]["subtitleLinks"]
                            if isinstance(s, dict) and s.get("title")
                        )

                if kind in ("trackLockup", "songLockup") or "track-list" in sec_id:
                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        t_title = _clean_space(item.get("title") or item.get("name") or "")
                        t_artist = _clean_space(item.get("artistName") or "")
                        if not t_artist and isinstance(item.get("subtitleLinks"), list):
                            t_artist = ", ".join(
                                _clean_space(s.get("title", ""))
                                for s in item["subtitleLinks"]
                                if isinstance(s, dict) and s.get("title")
                            )
                        if not t_title:
                            continue
                        entry = {
                            "title": t_title,
                            "artist": t_artist or header_artist,
                            "duration": round((item.get("duration") or 0) / 1000),
                            "_raw_id": str(item.get("id") or ""),
                            "_serialized": json.dumps(item.get("playAction") or {}) if target_track_id else "",
                        }
                        tracks.append(entry)
        except Exception:
            pass

    if not title:
        raw_og = _clean_space(doc.meta.get("og:title") or doc.title or "")
        title = re.sub(r"\s+(?:on|by.*on)\s+Apple\s+Music$", "", raw_og, flags=re.I).strip()

    if target_track_id and tracks:
        for t in tracks:
            if target_track_id in t.get("_raw_id", "") or target_track_id in t.get("_serialized", ""):
                return title, [{"title": t["title"], "artist": t["artist"], "duration": t["duration"]}]

    cleaned_tracks = [
        {"title": t["title"], "artist": t["artist"], "duration": t["duration"]}
        for t in tracks[:MAX_IMPORT_TRACKS]
    ]
    return title, cleaned_tracks


async def _fetch_apple_source(client: httpx.AsyncClient, parsed: Dict[str, Any]) -> Dict[str, Any]:
    kind = parsed["kind"]
    item_id = parsed["item_id"]
    album_id = parsed.get("album_id")
    country = parsed.get("country") or "us"

    # Fast official iTunes Lookup API for single songs and albums
    if kind == "track":
        if album_id:
            try:
                r = await client.get(
                    "https://itunes.apple.com/lookup",
                    params={"id": album_id, "entity": "song", "country": country},
                    timeout=8.0,
                )
                if r.status_code == 200:
                    for item in r.json().get("results", []):
                        if (
                            item.get("wrapperType") == "track"
                            and item.get("kind") in ("song", "music-video")
                            and str(item.get("trackId")) == str(item_id)
                        ):
                            tr = _itunes_item_to_track(item)
                            if tr["title"]:
                                return {
                                    "provider": "apple",
                                    "kind": "track",
                                    "title": tr["title"],
                                    "total_source_tracks": 1,
                                    "source_tracks": [tr],
                                }
            except Exception:
                pass

        try:
            r = await client.get(
                "https://itunes.apple.com/lookup",
                params={"id": item_id, "country": country},
                timeout=8.0,
            )
            if r.status_code == 200:
                for item in r.json().get("results", []):
                    if item.get("wrapperType") == "track" and item.get("kind") in ("song", "music-video"):
                        tr = _itunes_item_to_track(item)
                        if tr["title"]:
                            return {
                                "provider": "apple",
                                "kind": "track",
                                "title": tr["title"],
                                "total_source_tracks": 1,
                                "source_tracks": [tr],
                            }
        except Exception:
            pass

    elif kind == "album":
        try:
            r = await client.get(
                "https://itunes.apple.com/lookup",
                params={"id": item_id, "entity": "song", "country": country, "limit": 120},
                timeout=10.0,
            )
            if r.status_code == 200:
                results = r.json().get("results", [])
                album_title = ""
                song_items = []
                for item in results:
                    if item.get("wrapperType") == "collection" and not album_title:
                        album_title = _clean_space(item.get("collectionName") or "")
                    elif item.get("wrapperType") == "track" and item.get("kind") in ("song", "music-video"):
                        song_items.append(item)
                if song_items:
                    song_items.sort(key=lambda x: (int(x.get("discNumber") or 1), int(x.get("trackNumber") or 0)))
                    tracks = [_itunes_item_to_track(s) for s in song_items[:MAX_IMPORT_TRACKS] if s.get("trackName")]
                    if tracks:
                        return {
                            "provider": "apple",
                            "kind": "album",
                            "title": album_title or tracks[0].get("album") or "Apple Music Album",
                            "total_source_tracks": len(song_items),
                            "source_tracks": tracks,
                        }
        except Exception:
            pass

    # Playlist page (or HTML fallback when iTunes lookup has no entry for country/song)
    try:
        resp = await client.get(parsed["canonical_url"], headers=BROWSER_HEADERS, follow_redirects=False, timeout=12.0)
        if resp.status_code == 200:
            page_title, page_tracks = _extract_apple_serialized_tracks(
                resp.text,
                target_track_id=item_id if kind == "track" else None,
            )
            if page_tracks:
                if kind == "track":
                    tr = page_tracks[0]
                    return {
                        "provider": "apple",
                        "kind": "track",
                        "title": tr["title"],
                        "total_source_tracks": 1,
                        "source_tracks": [tr],
                    }
                return {
                    "provider": "apple",
                    "kind": kind,
                    "title": page_title or f"Apple Music {kind.title()}",
                    "total_source_tracks": len(page_tracks),
                    "source_tracks": page_tracks,
                }

            # Last resort for /song/ or ?i= if track section wasn't populated
            if kind == "track":
                doc = _parse_html(resp.text)
                raw_og = _clean_space(doc.meta.get("og:title") or doc.title or "")
                m = re.match(r"^(.*?)\s+by\s+(.*?)\s+on\s+Apple\s+Music$", raw_og, re.I)
                if m:
                    s_title = _clean_space(m.group(1))
                    s_artist = _clean_space(m.group(2))
                    if s_title:
                        return {
                            "provider": "apple",
                            "kind": "track",
                            "title": s_title,
                            "total_source_tracks": 1,
                            "source_tracks": [{"title": s_title, "artist": s_artist, "duration": 0}],
                        }
    except Exception:
        pass

    raise ValueError("Could not read that Apple Music link. Make sure the item exists and is public.")


def _strip_soundtrack_suffix(title: str) -> str:
    cleaned = re.sub(r"\s*(?:\[From\b[^\]]*\]|\(From\b[^)]*\))", "", title or "", flags=re.I)
    cleaned = re.sub(r"\s+-\s+From\s+[\"'].*$", "", cleaned, flags=re.I)
    return re.sub(r"\s{2,}", " ", cleaned).strip() or title.strip()


def _contains_modifier(norm_text: str, modifier: str) -> bool:
    return bool(re.search(rf"(?:^|\b){re.escape(modifier)}(?:\b|$)", norm_text))


def _version_modifier_penalty(src_title: str, cand_title: str) -> float:
    src_norm = _normalize_text(src_title)
    cand_norm = _normalize_text(cand_title)
    penalty = 0.0
    for mod in UNWANTED_VERSION_MODIFIERS:
        if _contains_modifier(cand_norm, mod) and not _contains_modifier(src_norm, mod):
            penalty += 0.45
    for mod in SOFT_VERSION_MODIFIERS:
        if _contains_modifier(cand_norm, mod) and not _contains_modifier(src_norm, mod):
            penalty += 0.25
    return penalty


def _score_candidate(
    src_title: str,
    src_artist: str,
    src_dur: int,
    cand_formatted: Dict[str, Any],
) -> Tuple[bool, float]:
    cand_title = cand_formatted.get("title") or ""
    cand_artist = cand_formatted.get("artist") or ""
    cand_dur = int(cand_formatted.get("duration") or 0)

    valid, base_score = is_valid_match(
        src_title,
        src_artist,
        cand_title,
        cand_artist,
        query_dur=src_dur or None,
        cand_dur=cand_dur or None,
    )
    penalty = _version_modifier_penalty(src_title, cand_title)
    if valid:
        dur_bonus = 0.12 if (src_dur and cand_dur and abs(src_dur - cand_dur) <= 4) else 0.0
        return True, base_score + dur_bonus - penalty

    # Lenient check for Bollywood/OST credits where YT artist lists movie/uploader instead of singer
    src_tokens = _tokenize(clean_track_title(src_title))
    cand_tokens = _tokenize(clean_track_title(cand_title))
    if src_tokens and cand_tokens:
        title_overlap = len(src_tokens & cand_tokens) / max(len(src_tokens), 1)
        dur_ok = (not src_dur or not cand_dur or abs(src_dur - cand_dur) <= 25)
        if title_overlap >= 0.85 and dur_ok and penalty == 0.0:
            return True, 0.55

    return False, max(0.0, 0.25 - penalty)


def match_track_on_youtube(
    ytmusic_client: Any,
    format_track_fn: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]],
    src_track: Dict[str, Any],
    max_results: int = 1,
) -> List[Dict[str, Any]]:
    """Search YouTube Music for a parsed Spotify/Apple track and return top ranked matches."""
    raw_title = _clean_space(src_track.get("title") or "")
    raw_artist = _clean_space(src_track.get("artist") or "")
    src_dur = int(src_track.get("duration") or 0)
    if not raw_title:
        return []

    search_title = clean_track_title(_strip_soundtrack_suffix(raw_title))
    artist_splits = _split_artist_candidates(raw_artist, raw_title)
    primary_artist = artist_splits[0] if artist_splits else raw_artist

    primary_query = f"{search_title} {primary_artist}".strip()
    queries = [primary_query]
    if len(artist_splits) >= 2:
        queries.append(f"{search_title} {artist_splits[1]}".strip())
    compact_title = _strip_soundtrack_suffix(raw_title)
    if compact_title.lower() != search_title.lower() and len(compact_title) <= 65:
        queries.append(f"{compact_title} {primary_artist}".strip())

    raw_candidates: List[Dict[str, Any]] = []
    seen_vids = set()

    def _collect(search_res: List[Dict[str, Any]]) -> None:
        for item in search_res or []:
            t = format_track_fn(item)
            if t and t["videoId"] not in seen_vids:
                seen_vids.add(t["videoId"])
                raw_candidates.append(t)

    try:
        _collect(ytmusic_client.search(queries[0], filter="songs", limit=6))
    except Exception:
        pass

    for alt_q in queries[1:]:
        scored = [
            (*_score_candidate(search_title, raw_artist, src_dur, c), idx, c)
            for idx, c in enumerate(raw_candidates)
        ]
        if any(ok and score >= 0.65 for ok, score, _, _ in scored):
            break
        try:
            _collect(ytmusic_client.search(alt_q, filter="songs", limit=5))
        except Exception:
            pass

    if not raw_candidates:
        try:
            _collect(ytmusic_client.search(queries[0], filter="videos", limit=5))
        except Exception:
            pass

    if not raw_candidates:
        return []

    final_scored = [
        (*_score_candidate(search_title, raw_artist, src_dur, c), idx, c)
        for idx, c in enumerate(raw_candidates)
    ]
    # Strict/valid matches first sorted by score desc, then original order
    final_scored.sort(key=lambda row: (1 if row[0] else 0, row[1], -row[2]), reverse=True)

    if max_results == 1:
        best_ok, best_score, _, best_track = final_scored[0]
        if best_ok or best_score >= 0.25:
            return [best_track]
        return []

    return [row[3] for row in final_scored[:max_results]]


async def import_external_url(
    client: httpx.AsyncClient,
    ytmusic_client: Any,
    format_track_fn: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]],
    raw_url: str,
) -> Dict[str, Any]:
    """
    Resolve a Spotify or Apple Music URL/URI and match its track(s) onto YouTube Music.
    """
    parsed = parse_external_url(raw_url)

    if parsed["kind"] == "shortlink":
        redirect_allow = (
            (SPOTIFY_DIRECT_HOSTS | SPOTIFY_SHORT_HOSTS)
            if parsed["provider"] == "spotify"
            else (APPLE_DIRECT_HOSTS | APPLE_SHORT_HOSTS)
        )
        resolved = await _resolve_short_link(client, parsed["canonical_url"], redirect_allow)
        parsed = parse_external_url(resolved)
        if parsed["kind"] == "shortlink":
            raise ValueError("Could not resolve shortened music link.")

    cache_key = (parsed["provider"], parsed["kind"], parsed["canonical_url"])
    cached = IMPORT_CACHE.get(cache_key)
    if cached is not None:
        return cached

    if parsed["provider"] == "spotify":
        source = await _fetch_spotify_source(client, parsed)
    else:
        source = await _fetch_apple_source(client, parsed)

    source_tracks = source.get("source_tracks") or []
    kind = source["kind"]

    if kind == "track":
        matches = await asyncio.to_thread(
            match_track_on_youtube,
            ytmusic_client,
            format_track_fn,
            source_tracks[0],
            6,
        )
        payload = {
            "provider": source["provider"],
            "kind": "track",
            "title": source["title"],
            "sourceTrack": source_tracks[0],
            "totalSourceTracks": 1,
            "matchedCount": 1 if matches else 0,
            "unmatchedTracks": [] if matches else [f"{source_tracks[0]['title']} — {source_tracks[0]['artist']}"],
            "results": matches,
        }
        if matches:
            IMPORT_CACHE.set(cache_key, payload)
        return payload

    # Album or Playlist: match tracks concurrently with bounded concurrency
    sem = asyncio.Semaphore(8)

    async def _match_one(src: Dict[str, Any]) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
        async with sem:
            found = await asyncio.to_thread(match_track_on_youtube, ytmusic_client, format_track_fn, src, 1)
            return src, (found[0] if found else None)

    matched_pairs = await asyncio.gather(*(_match_one(t) for t in source_tracks))

    results: List[Dict[str, Any]] = []
    unmatched: List[str] = []
    seen_vids = set()
    for src, match in matched_pairs:
        if match and match["videoId"] not in seen_vids:
            seen_vids.add(match["videoId"])
            results.append(match)
        elif not match:
            unmatched.append(f"{src['title']} — {src['artist']}" if src.get("artist") else src["title"])

    if not results:
        raise ValueError("Could not match any playable tracks from this link on YouTube Music.")

    payload = {
        "provider": source["provider"],
        "kind": kind,
        "title": source["title"],
        "sourceTrack": None,
        "totalSourceTracks": source.get("total_source_tracks", len(source_tracks)),
        "matchedCount": len(results),
        "unmatchedTracks": unmatched[:15],
        "results": results,
    }
    IMPORT_CACHE.set(cache_key, payload)
    return payload
