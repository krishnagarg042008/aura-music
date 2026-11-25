import asyncio
import json
import os
import re
import time
from collections import OrderedDict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from ytmusicapi import YTMusic

from backend.cache import BoundedTTLCache, SingleFlight
from backend.importer import import_external_url
from backend.lyrics_engine import fetch_synced_lyrics
from backend.vibe_engine import (
    VIBE_PROFILES,
    classify_vibe,
    extract_palette,
    is_allowed_thumbnail_url,
)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
VIDEO_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{6,20}$")

ytmusic = YTMusic()
STREAM_CACHE: BoundedTTLCache[Tuple[str, str]] = BoundedTTLCache(maxsize=200, ttl=1800.0)
TRENDING_CACHE: BoundedTTLCache[List[Dict[str, Any]]] = BoundedTTLCache(maxsize=4, ttl=1800.0)
SEARCH_CACHE: BoundedTTLCache[List[Dict[str, Any]]] = BoundedTTLCache(maxsize=128, ttl=300.0)
META_CACHE: BoundedTTLCache[Dict[str, Any]] = BoundedTTLCache(maxsize=300, ttl=3600.0)

STREAM_FLIGHT = SingleFlight()
TRENDING_FLIGHT = SingleFlight()
http_client: Optional[httpx.AsyncClient] = None


def _validate_video_id(video_id: str) -> str:
    if not VIDEO_ID_RE.fullmatch(video_id or ""):
        raise HTTPException(status_code=400, detail="Invalid video ID format.")
    return video_id


def _parse_cors_origins() -> List[str]:
    raw = os.environ.get("AURA_CORS_ORIGINS", "*").strip()
    if not raw or raw == "*":
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


class SlidingWindowRateLimiter:
    """Bounded per-IP sliding-window rate limiter for API abuse prevention."""

    def __init__(self, max_clients: int = 2048) -> None:
        self.max_clients = max_clients
        self._buckets: OrderedDict[Tuple[str, str], Deque[float]] = OrderedDict()

    def allow(self, client_key: str, bucket: str, limit: int, window_sec: float = 60.0) -> bool:
        now = time.monotonic()
        key = (client_key, bucket)
        q = self._buckets.get(key)
        if q is None:
            q = deque()
            self._buckets[key] = q
        else:
            self._buckets.move_to_end(key)

        cutoff = now - window_sec
        while q and q[0] <= cutoff:
            q.popleft()

        if len(q) >= limit:
            return False

        q.append(now)
        while len(self._buckets) > self.max_clients:
            self._buckets.popitem(last=False)
        return True


RATE_LIMITER = SlidingWindowRateLimiter()


def get_http_client() -> httpx.AsyncClient:
    global http_client
    if http_client is None or http_client.is_closed:
        http_client = httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(20.0, read=60.0))
    return http_client


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_http_client()
    yield
    global http_client
    if http_client and not http_client.is_closed:
        await http_client.aclose()


app = FastAPI(title="AURA Music Engine", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    enabled = os.environ.get("AURA_RATE_LIMIT_ENABLED", "1").lower() not in ("0", "false", "no")
    path = request.url.path
    if enabled and path.startswith("/api/"):
        client_ip = request.client.host if request.client else "unknown"
        if path.startswith("/api/stream/"):
            bucket, limit = "stream", 120
        elif path.startswith("/api/playlist") or path.startswith("/api/import"):
            bucket, limit = "playlist", 25
        else:
            bucket, limit = "api", 180

        if not RATE_LIMITER.allow(client_ip, bucket, limit=limit, window_sec=60.0):
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded. Please wait a moment and try again."},
                headers={"Retry-After": "10"},
            )

    return await call_next(request)


def _upgrade_thumbnail(thumbnails: List[Dict[str, Any]], video_id: str) -> str:
    if thumbnails:
        url = thumbnails[-1].get("url", "")
        if "googleusercontent.com" in url:
            return re.sub(r"w\d+-h\d+", "w1000-h1000", url)
        return url
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def _format_track(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    video_id = item.get("videoId")
    if not video_id:
        return None

    artists_list = item.get("artists") or []
    artist = ", ".join(a.get("name", "") for a in artists_list if a.get("name")) or "YouTube Artist"
    album_obj = item.get("album")
    album = album_obj.get("name", "") if isinstance(album_obj, dict) else ""

    duration_sec = item.get("duration_seconds")
    if not duration_sec and item.get("duration"):
        parts = [int(p) for p in str(item["duration"]).split(":") if p.isdigit()]
        if len(parts) == 2:
            duration_sec = parts[0] * 60 + parts[1]
        elif len(parts) == 3:
            duration_sec = parts[0] * 3600 + parts[1] * 60 + parts[2]

    return {
        "videoId": video_id,
        "title": item.get("title", "Unknown Track"),
        "artist": artist,
        "album": album,
        "duration": duration_sec or 0,
        "durationText": item.get("duration") or "",
        "thumbnail": _upgrade_thumbnail(item.get("thumbnails") or [], video_id),
    }


def _resolve_youtube_audio(video_id: str) -> Tuple[str, str]:
    cached = STREAM_CACHE.get(video_id)
    if cached is not None:
        return cached

    # Try mobile player clients (android, ios, mweb) to bypass "Sign in to confirm you're not a bot" on datacenter IPs (Vercel, Render, AWS)
    client_candidates = [
        ["android"],
        ["android", "ios"],
        ["mweb"],
        ["web"],
    ]

    url = f"https://www.youtube.com/watch?v={video_id}"
    mime_map = {
        "m4a": "audio/mp4",
        "mp4": "audio/mp4",
        "webm": "audio/webm",
        "opus": "audio/ogg",
        "mp3": "audio/mpeg",
    }

    last_error = None
    for clients in client_candidates:
        ydl_opts = {
            "format": "bestaudio/best",
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "extract_flat": False,
            "extractor_args": {
                "youtube": {
                    "player_client": clients
                }
            },
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                stream_url = info.get("url")
                ext = info.get("ext", "mp4")
                content_type = mime_map.get(ext, "audio/mp4")
                if stream_url:
                    STREAM_CACHE.set(video_id, (stream_url, content_type))
                    return stream_url, content_type
        except Exception as exc:
            last_error = exc
            continue

    raise RuntimeError(f"Could not extract audio stream: {last_error}")


async def _resolve_youtube_audio_coalesced(video_id: str) -> Tuple[str, str]:
    cached = STREAM_CACHE.get(video_id)
    if cached is not None:
        return cached

    async def _do_resolve() -> Tuple[str, str]:
        rechecked = STREAM_CACHE.get(video_id)
        if rechecked is not None:
            return rechecked
        return await asyncio.to_thread(_resolve_youtube_audio, video_id)

    return await STREAM_FLIGHT.run(video_id, _do_resolve)


def _extract_yt_initial_data(html: str) -> Optional[Dict[str, Any]]:
    decoder = json.JSONDecoder()
    for marker in ("var ytInitialData = ", 'window["ytInitialData"] = ', "ytInitialData = "):
        idx = html.find(marker)
        if idx != -1:
            start = html.find("{", idx)
            if start != -1:
                try:
                    data, _ = decoder.raw_decode(html, start)
                    if isinstance(data, dict):
                        return data
                except Exception:
                    continue
    return None


def _parse_playlist_from_initial_data(data: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]]]:
    title = (
        data.get("metadata", {})
        .get("playlistMetadataRenderer", {})
        .get("title")
        or "YouTube Playlist"
    )
    tracks: List[Dict[str, Any]] = []
    seen = set()

    def _get_text(obj: Any) -> str:
        if not isinstance(obj, dict):
            return ""
        if "simpleText" in obj:
            return str(obj["simpleText"])
        if "runs" in obj and isinstance(obj["runs"], list):
            return "".join(str(r.get("text", "")) for r in obj["runs"] if isinstance(r, dict))
        return ""

    def _walk(node: Any):
        if isinstance(node, dict):
            if "playlistVideoRenderer" in node and isinstance(node["playlistVideoRenderer"], dict):
                r = node["playlistVideoRenderer"]
                vid = r.get("videoId")
                t_name = _get_text(r.get("title")).strip()
                if vid and vid not in seen and t_name not in ("[Deleted video]", "[Private video]"):
                    seen.add(vid)
                    artist = _get_text(r.get("shortBylineText")).strip() or "YouTube"
                    dur_sec = int(r.get("lengthSeconds") or 0)
                    dur_text = _get_text(r.get("lengthText")).strip() or (
                        f"{dur_sec // 60}:{dur_sec % 60:02d}" if dur_sec else ""
                    )
                    thumbs = (r.get("thumbnail") or {}).get("thumbnails") or []
                    tracks.append({
                        "videoId": vid,
                        "title": t_name or "Unknown Track",
                        "artist": artist,
                        "album": title,
                        "duration": dur_sec,
                        "durationText": dur_text,
                        "thumbnail": _upgrade_thumbnail(thumbs, vid),
                    })
                return
            for v in node.values():
                _walk(v)
        elif isinstance(node, list):
            for item in node:
                _walk(item)

    _walk(data)
    return title, tracks


@app.get("/api/search")
async def search_tracks(q: str = Query(..., min_length=1), limit: int = Query(18, ge=1, le=50)):
    cache_key = (q.strip().lower(), limit)
    cached = SEARCH_CACHE.get(cache_key)
    if cached is not None:
        return {"results": cached}

    def _do_search():
        songs = ytmusic.search(q, filter="songs", limit=limit)
        if len(songs) < 6:
            videos = ytmusic.search(q, filter="videos", limit=10)
            songs.extend(videos)
        return songs

    raw = await asyncio.to_thread(_do_search)
    seen = set()
    results = []
    for item in raw:
        track = _format_track(item)
        if track and track["videoId"] not in seen:
            seen.add(track["videoId"])
            results.append(track)
    trimmed = results[:limit]
    SEARCH_CACHE.set(cache_key, trimmed)
    return {"results": trimmed}


TRENDING_QUERIES = [
    "Blinding Lights The Weeknd",
    "Kesariya Arijit Singh",
    "FE!N Travis Scott",
    "Birds of a Feather Billie Eilish",
    "Numb Linkin Park",
    "Starboy Daft Punk",
    "Chura Liya Hai Tumne",
    "Lofi hip hop chill beats",
]


@app.get("/api/trending")
async def get_trending():
    """Fallback discover feed — cached and parallelized for fast startup."""
    cached = TRENDING_CACHE.get("trending")
    if cached is not None:
        return {"results": cached}

    async def _build_trending() -> List[Dict[str, Any]]:
        rechecked = TRENDING_CACHE.get("trending")
        if rechecked is not None:
            return rechecked

        def _fetch_one(query: str) -> Optional[Dict[str, Any]]:
            try:
                res = ytmusic.search(query, filter="songs", limit=2)
                for item in res:
                    t = _format_track(item)
                    if t:
                        return t
            except Exception as exc:
                print(f"[Trending] search failed for {query!r}: {exc}")
            return None

        candidates = await asyncio.gather(*(asyncio.to_thread(_fetch_one, q) for q in TRENDING_QUERIES))
        tracks: List[Dict[str, Any]] = []
        seen = set()
        for t in candidates:
            if t and t["videoId"] not in seen:
                seen.add(t["videoId"])
                tracks.append(t)

        if tracks:
            TRENDING_CACHE.set("trending", tracks)
        return tracks

    tracks = await TRENDING_FLIGHT.run("trending", _build_trending)
    return {"results": tracks}


@app.post("/api/recommendations")
async def get_recommendations(request: Request):
    """
    Personalised recommendations seeded by listening history.

    Accepts JSON body:
      {
        "seedVideoIds": ["id1", "id2", ...],   // recent videoIds (up to 5)
        "topArtists":   ["artist1", "artist2"], // most-played artists (up to 5)
        "excludeIds":   ["id3", "id4"]          // already-displayed ids to skip
      }

    Strategy:
      1. YouTube Music radio (get_watch_playlist) seeded from recent videoIds.
      2. Artist-based search for top artists the user listens to.
      3. De-duplicate and shuffle for variety.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    seed_ids: List[str] = (body.get("seedVideoIds") or [])[:5]
    top_artists: List[str] = (body.get("topArtists") or [])[:5]
    exclude_ids: set = set(body.get("excludeIds") or [])

    if not seed_ids and not top_artists:
        # No history — fall back to trending
        return await get_trending()

    def _build_recommendations():
        import random
        tracks: List[Dict[str, Any]] = []
        seen: set = set(exclude_ids)

        def _add_track(item: Dict[str, Any]) -> bool:
            t = _format_track(item)
            if t and t["videoId"] not in seen:
                seen.add(t["videoId"])
                tracks.append(t)
                return True
            return False

        # ── Strategy 1: Radio from seed videoIds ──
        for vid in seed_ids[:3]:
            try:
                watch = ytmusic.get_watch_playlist(videoId=vid, limit=15)
                for item in (watch.get("tracks") or [])[1:]:  # skip [0] = the seed itself
                    if not isinstance(item, dict):
                        continue
                    # get_watch_playlist returns slightly different format
                    formatted = {
                        "videoId": item.get("videoId"),
                        "title": item.get("title") or "",
                        "artists": item.get("artists") or [],
                        "album": item.get("album") or {},
                        "thumbnails": item.get("thumbnail") if isinstance(item.get("thumbnail"), list) else [],
                        "duration": item.get("length") or "",
                        "duration_seconds": None,
                    }
                    # Parse duration text
                    dur_text = item.get("length") or ""
                    if isinstance(dur_text, str) and ":" in dur_text:
                        parts = [int(p) for p in dur_text.split(":") if p.isdigit()]
                        if len(parts) == 2:
                            formatted["duration_seconds"] = parts[0] * 60 + parts[1]
                            formatted["duration"] = dur_text
                    _add_track(formatted)
                    if len(tracks) >= 25:
                        break
            except Exception as e:
                print(f"[Recs] watch_playlist error for {vid}: {e}")
                continue

        # ── Strategy 2: Search for top artists ──
        for artist in top_artists[:4]:
            try:
                results = ytmusic.search(artist, filter="songs", limit=6)
                for item in results:
                    _add_track(item)
                    if len(tracks) >= 30:
                        break
            except Exception as e:
                print(f"[Recs] artist search error for {artist}: {e}")
                continue

        # ── Shuffle to mix radio + artist tracks ──
        if len(tracks) > 8:
            # Keep first 3 (most relevant radio picks), shuffle the rest
            head = tracks[:3]
            tail = tracks[3:]
            random.shuffle(tail)
            tracks = head + tail

        return tracks[:20]

    tracks = await asyncio.to_thread(_build_recommendations)
    return {"results": tracks}



@app.get("/api/track/{video_id}/meta")
async def get_track_meta(
    video_id: str,
    title: str = Query(...),
    artist: str = Query(""),
    duration: int = Query(0),
    thumb: str = Query(""),
):
    _validate_video_id(video_id)
    safe_thumb = (
        thumb.strip()
        if is_allowed_thumbnail_url(thumb)
        else f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    )
    meta_key = (video_id, title.strip(), artist.strip(), int(duration or 0), safe_thumb)
    cached_meta = META_CACHE.get(meta_key)
    if cached_meta is not None:
        return cached_meta

    client = get_http_client()
    lyrics_task = fetch_synced_lyrics(client, title, artist, duration or None, video_id=video_id)
    palette_task = extract_palette(client, safe_thumb)
    lyrics_data, palette = await asyncio.gather(lyrics_task, palette_task)

    vibe = classify_vibe(title, artist, lyrics_data.get("plain_text", ""))
    vibe["colors"] = palette

    payload = {
        "videoId": video_id,
        "vibe": vibe,
        "availableVibes": list(VIBE_PROFILES.values()),
        "lyrics": lyrics_data,
    }
    META_CACHE.set(meta_key, payload)
    return payload


@app.get("/api/playlist")
async def import_youtube_playlist(url: str = Query(..., min_length=2)):
    """Import tracks from any Public or Unlisted YouTube / YT Music playlist URL or ID."""
    client = get_http_client()
    raw = url.strip()
    parsed = urlparse(raw)
    qs = parse_qs(parsed.query)
    playlist_id = qs.get("list", [None])[0]

    if not playlist_id:
        match = re.search(r"(?:[?&]list=|/browse/)([a-zA-Z0-9_-]+)", raw)
        playlist_id = match.group(1) if match else raw

    playlist_id = playlist_id.split("&")[0].strip()
    if playlist_id.startswith("VL"):
        playlist_id = playlist_id[2:]

    if playlist_id in ("LM", "LL", "WL"):
        raise HTTPException(
            status_code=400,
            detail="Liked Music / Watch Later are private. Copy them into an Unlisted or Public playlist first.",
        )

    if not re.fullmatch(r"[a-zA-Z0-9_-]{2,128}", playlist_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid YouTube playlist URL or ID.",
        )

    errors: List[str] = []

    # Method 1: Direct YouTube playlist page parse (fast & works for Public/Unlisted YT & YT Music playlists)
    try:
        resp = await client.get(
            f"https://www.youtube.com/playlist?list={playlist_id}",
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9",
                "Cookie": "CONSENT=YES+cb.20230531-07-p0.en+FX+917",
            },
            timeout=12.0,
        )
        initial_data = _extract_yt_initial_data(resp.text)
        if initial_data:
            title, tracks = _parse_playlist_from_initial_data(initial_data)
            if tracks:
                return {"title": title, "results": tracks}
    except Exception as e:
        errors.append(f"direct_scrape: {e}")

    def _fetch_fallbacks():
        # Method 2: ytmusicapi get_playlist
        try:
            pl = ytmusic.get_playlist(playlist_id, limit=100)
            title = pl.get("title") or "YouTube Playlist"
            tracks = []
            seen = set()
            for item in pl.get("tracks") or []:
                if not isinstance(item, dict):
                    continue
                t = _format_track(item)
                if t and t["videoId"] not in seen:
                    seen.add(t["videoId"])
                    tracks.append(t)
            if tracks:
                return title, tracks
        except Exception as e:
            errors.append(f"ytmusic.get_playlist: {e}")

        # Method 3: ytmusicapi watch playlist (Mixes / RD... / Radio)
        try:
            watch = ytmusic.get_watch_playlist(playlistId=playlist_id, limit=100)
            tracks = []
            seen = set()
            for item in watch.get("tracks") or []:
                if not isinstance(item, dict):
                    continue
                vid = item.get("videoId")
                if not vid or vid in seen:
                    continue
                seen.add(vid)
                artists = ", ".join(a.get("name", "") for a in (item.get("artists") or []) if a.get("name"))
                thumbs = item.get("thumbnail") or item.get("thumbnails") or []
                dur_text = item.get("length") or ""
                parts = [int(p) for p in str(dur_text).split(":") if p.isdigit()]
                dur_sec = (parts[0] * 60 + parts[1]) if len(parts) == 2 else 0
                tracks.append({
                    "videoId": vid,
                    "title": item.get("title") or "Unknown Track",
                    "artist": artists or "YouTube Music",
                    "album": "",
                    "duration": dur_sec,
                    "durationText": dur_text,
                    "thumbnail": _upgrade_thumbnail(thumbs, vid),
                })
            if tracks:
                return "YouTube Music Mix", tracks
        except Exception as e:
            errors.append(f"ytmusic.get_watch_playlist: {e}")

        # Method 4: yt-dlp flat extraction
        try:
            ydl_opts = {
                "extract_flat": "in_playlist",
                "ignoreerrors": True,
                "skip_download": True,
                "quiet": True,
                "no_warnings": True,
                "playlistend": 100,
            }
            pl_url = f"https://www.youtube.com/playlist?list={playlist_id}"
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(pl_url, download=False)
                if isinstance(info, dict):
                    title = info.get("title") or "YouTube Playlist"
                    tracks = []
                    seen = set()
                    for entry in info.get("entries") or []:
                        if not isinstance(entry, dict):
                            continue
                        vid = entry.get("id")
                        t_name = entry.get("title") or ""
                        if not vid or vid in seen or t_name in ("[Deleted video]", "[Private video]"):
                            continue
                        seen.add(vid)
                        dur = int(entry.get("duration") or 0)
                        thumbs = entry.get("thumbnails") or []
                        thumb = _upgrade_thumbnail(thumbs, vid) if thumbs else f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
                        tracks.append({
                            "videoId": vid,
                            "title": t_name or "Unknown Track",
                            "artist": entry.get("uploader") or entry.get("channel") or "YouTube",
                            "album": title,
                            "duration": dur,
                            "durationText": f"{dur // 60}:{dur % 60:02d}" if dur else "",
                            "thumbnail": thumb,
                        })
                    if tracks:
                        return title, tracks
        except Exception as e:
            errors.append(f"yt-dlp: {e}")

        return None, None

    title, tracks = await asyncio.to_thread(_fetch_fallbacks)
    if tracks:
        return {"title": title, "results": tracks}

    print(f"[Playlist Import Failed] id={playlist_id} | errors={errors}")
    raise HTTPException(
        status_code=400,
        detail=f"YouTube blocked playlist '{playlist_id}'. Make sure its privacy is Public or Unlisted (not Private).",
    )


@app.get("/api/import-external")
async def import_external_music(url: str = Query(..., min_length=4)):
    """Import tracks or songs from a public Spotify or Apple Music URL/URI and match on YouTube Music."""
    client = get_http_client()
    try:
        return await import_external_url(client, ytmusic, _format_track, url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        print(f"[External Import Failed] url={url!r} | error={exc}")
        raise HTTPException(status_code=502, detail="Could not import from that link right now. Please try again.")


@app.api_route("/api/stream/{video_id}", methods=["GET", "HEAD"])
async def stream_audio(video_id: str, request: Request):
    _validate_video_id(video_id)
    client = get_http_client()
    try:
        stream_url, content_type = await _resolve_youtube_audio_coalesced(video_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to resolve YouTube audio: {exc}")

    req_headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    }
    if "range" in request.headers:
        req_headers["Range"] = request.headers["range"]

    upstream_req = client.build_request(request.method, stream_url, headers=req_headers)
    upstream_resp = await client.send(upstream_req, stream=True)

    if upstream_resp.status_code in (403, 410):
        await upstream_resp.aclose()
        STREAM_CACHE.delete(video_id)
        try:
            stream_url, content_type = await _resolve_youtube_audio_coalesced(video_id)
            upstream_req = client.build_request(request.method, stream_url, headers=req_headers)
            upstream_resp = await client.send(upstream_req, stream=True)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Failed to refresh YouTube audio stream: {exc}")

    if upstream_resp.status_code >= 400:
        status_code = upstream_resp.status_code
        await upstream_resp.aclose()
        raise HTTPException(status_code=502, detail=f"Upstream audio server returned HTTP {status_code}")

    resp_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, Content-Range, Accept-Ranges, Content-Type, Origin, User-Agent",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    }
    for h in ("content-length", "content-range", "content-type"):
        if h in upstream_resp.headers:
            resp_headers[h.title()] = upstream_resp.headers[h]
    resp_headers.setdefault("Content-Type", content_type)

    if request.method == "HEAD":
        await upstream_resp.aclose()
        return Response(status_code=upstream_resp.status_code, headers=resp_headers)

    async def byte_generator():
        try:
            async for chunk in upstream_resp.aiter_bytes(chunk_size=65536):
                yield chunk
        finally:
            await upstream_resp.aclose()

    return StreamingResponse(
        byte_generator(),
        status_code=upstream_resp.status_code,
        headers=resp_headers,
    )


# Mount frontend assets
app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")
app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")


@app.get("/manifest.json")
async def serve_manifest():
    return FileResponse(FRONTEND_DIR / "manifest.json", media_type="application/manifest+json")


@app.get("/sw.js")
async def serve_service_worker():
    return FileResponse(
        FRONTEND_DIR / "sw.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/icons/{icon_name}")
async def serve_icon(icon_name: str):
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+", icon_name):
        raise HTTPException(status_code=404, detail="Not found")
    icon_path = FRONTEND_DIR / "icons" / icon_name
    if not icon_path.is_file():
        raise HTTPException(status_code=404, detail="Icon not found")
    return FileResponse(icon_path)


@app.get("/health")
@app.get("/healthz")
async def health_check():
    return {"status": "ok", "app": "AURA Music"}


@app.get("/")
async def serve_index():
    return FileResponse(FRONTEND_DIR / "index.html")


if __name__ == "__main__":
    import os
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    host = os.environ.get("HOST", "0.0.0.0")
    uvicorn.run("backend.main:app", host=host, port=port, reload=False)
