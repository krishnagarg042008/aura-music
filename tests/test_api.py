import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

from backend.main import (
    META_CACHE,
    SEARCH_CACHE,
    STREAM_CACHE,
    SlidingWindowRateLimiter,
    TRENDING_CACHE,
    app,
)


class TestApiEndpoints(unittest.TestCase):
    def setUp(self):
        STREAM_CACHE.clear()
        TRENDING_CACHE.clear()
        SEARCH_CACHE.clear()
        META_CACHE.clear()
        self.client = TestClient(app)

    def test_health_and_pwa_assets(self):
        r1 = self.client.get("/health")
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r1.json()["status"], "ok")

        r2 = self.client.get("/healthz")
        self.assertEqual(r2.status_code, 200)

        manifest = self.client.get("/manifest.json")
        self.assertEqual(manifest.status_code, 200)
        self.assertEqual(manifest.json()["short_name"], "AURA Music")

        sw = self.client.get("/sw.js")
        self.assertEqual(sw.status_code, 200)

        icon = self.client.get("/icons/aura-icon.svg")
        self.assertEqual(icon.status_code, 200)

    def test_trending_caches_results(self):
        fake_item = {
            "videoId": "dQw4w9WgXcQ",
            "title": "Demo Song",
            "artist": "Demo Artist",
            "duration": "3:30",
            "thumbnails": [{"url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"}],
        }
        with patch("backend.main.ytmusic.search", return_value=[fake_item]) as mock_search:
            res1 = self.client.get("/api/trending")
            self.assertEqual(res1.status_code, 200)
            self.assertEqual(len(res1.json()["results"]), 1)
            calls_after_first = mock_search.call_count
            self.assertGreater(calls_after_first, 0)

            res2 = self.client.get("/api/trending")
            self.assertEqual(res2.status_code, 200)
            self.assertEqual(mock_search.call_count, calls_after_first)

    def test_track_meta_validation_and_ssrf_guard(self):
        bad = self.client.get("/api/track/invalid!id/meta?title=Test")
        self.assertEqual(bad.status_code, 400)

        mock_lyrics = AsyncMock(return_value={"synced": False, "word_native": False, "smart_sync": False, "plain_text": "", "lines": []})
        mock_palette = AsyncMock(return_value=["#111122", "#334455", "#667788"])

        with patch("backend.main.fetch_synced_lyrics", mock_lyrics), patch("backend.main.extract_palette", mock_palette):
            res = self.client.get(
                "/api/track/dQw4w9WgXcQ/meta",
                params={"title": "Test", "artist": "Artist", "thumb": "http://169.254.169.254/latest/meta-data"},
            )
            self.assertEqual(res.status_code, 200)
            # extract_palette should receive safe fallback YouTube thumbnail, never the internal metadata URL
            called_thumb = mock_palette.await_args.args[1]
            self.assertEqual(called_thumb, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")

            # Repeat call hits META_CACHE
            res2 = self.client.get(
                "/api/track/dQw4w9WgXcQ/meta",
                params={"title": "Test", "artist": "Artist", "thumb": "http://169.254.169.254/latest/meta-data"},
            )
            self.assertEqual(res2.status_code, 200)
            self.assertEqual(mock_lyrics.await_count, 1)

    def test_stream_audio_validates_id_and_handles_head_and_refresh(self):
        bad = self.client.get("/api/stream/not-valid!")
        self.assertEqual(bad.status_code, 400)

        upstream_403 = MagicMock()
        upstream_403.status_code = 403
        upstream_403.headers = {}
        upstream_403.aclose = AsyncMock()

        upstream_200 = MagicMock()
        upstream_200.status_code = 200
        upstream_200.headers = {"content-type": "audio/mp4", "content-length": "4"}
        upstream_200.aclose = AsyncMock()

        async def iter_bytes(chunk_size=65536):
            yield b"test"

        upstream_200.aiter_bytes = iter_bytes

        mock_client = MagicMock()
        mock_client.build_request = MagicMock(side_effect=lambda *a, **kw: ("REQ", a, kw))
        mock_client.send = AsyncMock(side_effect=[upstream_403, upstream_200])

        resolver = MagicMock(side_effect=[
            ("https://expired.example/audio", "audio/mp4"),
            ("https://fresh.example/audio", "audio/mp4"),
        ])

        with patch("backend.main.get_http_client", return_value=mock_client), patch(
            "backend.main._resolve_youtube_audio", resolver
        ):
            res = self.client.get("/api/stream/dQw4w9WgXcQ")
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.content, b"test")
            self.assertEqual(resolver.call_count, 2)

    def test_playlist_rejects_private_or_invalid_ids(self):
        r_priv = self.client.get("/api/playlist?url=LM")
        self.assertEqual(r_priv.status_code, 400)

        r_bad = self.client.get("/api/playlist?url=https://example.com/not-youtube")
        self.assertEqual(r_bad.status_code, 400)

    def test_sliding_window_rate_limiter(self):
        limiter = SlidingWindowRateLimiter(max_clients=4)
        self.assertTrue(limiter.allow("1.2.3.4", "playlist", limit=2, window_sec=60.0))
        self.assertTrue(limiter.allow("1.2.3.4", "playlist", limit=2, window_sec=60.0))
        self.assertFalse(limiter.allow("1.2.3.4", "playlist", limit=2, window_sec=60.0))


if __name__ == "__main__":
    unittest.main()
