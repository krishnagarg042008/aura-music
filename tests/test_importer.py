import json
import unittest
from unittest.mock import AsyncMock, MagicMock

import httpx

from backend.importer import (
    IMPORT_CACHE,
    _extract_apple_serialized_tracks,
    _parse_spotify_embed_entity,
    import_external_url,
    is_external_music_url,
    match_track_on_youtube,
    parse_external_url,
)
from backend.main import _format_track


class TestExternalUrlParsing(unittest.TestCase):
    def test_parses_spotify_urls_and_uris(self):
        t = parse_external_url("https://open.spotify.com/intl-en/track/0VjIjW4GlUZAMYd2vXMi3b?si=abc123")
        self.assertEqual(t["provider"], "spotify")
        self.assertEqual(t["kind"], "track")
        self.assertEqual(t["item_id"], "0VjIjW4GlUZAMYd2vXMi3b")

        p = parse_external_url("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M")
        self.assertEqual(p["provider"], "spotify")
        self.assertEqual(p["kind"], "playlist")
        self.assertEqual(p["canonical_url"], "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")

        s = parse_external_url("https://spotify.link/XyZ123abc")
        self.assertEqual(s["provider"], "spotify")
        self.assertEqual(s["kind"], "shortlink")

        bare_sp = parse_external_url("open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b")
        self.assertEqual(bare_sp["provider"], "spotify")
        self.assertEqual(bare_sp["item_id"], "0VjIjW4GlUZAMYd2vXMi3b")

        upper_uri = parse_external_url("Spotify:Album:4yP0hdKOZPNshxUOjY0cZj")
        self.assertEqual(upper_uri["kind"], "album")
        self.assertEqual(upper_uri["canonical_url"], "https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj")

    def test_parses_apple_music_track_album_and_playlist(self):
        song_in_album = parse_external_url("https://music.apple.com/in/album/after-hours/1499378108?i=1499378117")
        self.assertEqual(song_in_album["provider"], "apple")
        self.assertEqual(song_in_album["kind"], "track")
        self.assertEqual(song_in_album["item_id"], "1499378117")
        self.assertEqual(song_in_album["album_id"], "1499378108")
        self.assertEqual(song_in_album["country"], "in")

        direct_song = parse_external_url("https://music.apple.com/us/song/kesariya/1620776479")
        self.assertEqual(direct_song["kind"], "track")
        self.assertEqual(direct_song["item_id"], "1620776479")

        album = parse_external_url("https://music.apple.com/us/album/after-hours/1499378108")
        self.assertEqual(album["kind"], "album")

        bare_ap = parse_external_url("music.apple.com/us/song/kesariya/1620776479")
        self.assertEqual(bare_ap["provider"], "apple")
        self.assertEqual(bare_ap["kind"], "track")

        playlist = parse_external_url("https://music.apple.com/us/playlist/my-mix/pl.u-XkD0vLBSxYZ123")
        self.assertEqual(playlist["kind"], "playlist")
        self.assertEqual(playlist["item_id"], "pl.u-XkD0vLBSxYZ123")

    def test_rejects_ssrf_private_and_unsupported_urls(self):
        for bad in (
            "https://169.254.169.254/latest/meta-data",
            "https://localhost/track/0VjIjW4GlUZAMYd2vXMi3b",
            "http://127.0.0.1:8000/track/0VjIjW4GlUZAMYd2vXMi3b",
            "https://example.com/track/0VjIjW4GlUZAMYd2vXMi3b",
            "https://open.spotify.com/artist/1Xyo4u8uXC1ZmMpatF05PJ",
            "https://music.apple.com/library/playlist/p.12345",
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    parse_external_url(bad)

        self.assertTrue(is_external_music_url("https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b"))
        self.assertFalse(is_external_music_url("Blinding Lights The Weeknd"))


class TestProviderExtractionAndMatching(unittest.TestCase):
    def test_parses_spotify_embed_track_and_playlist(self):
        track_ent = {
            "type": "track",
            "title": "Kesariya",
            "duration": 268000,
            "artists": [{"name": "Pritam"}, {"name": "Arijit\xa0Singh"}],
        }
        parsed_t = _parse_spotify_embed_entity(track_ent, "track")
        self.assertEqual(parsed_t["kind"], "track")
        self.assertEqual(parsed_t["source_tracks"][0]["artist"], "Pritam, Arijit Singh")
        self.assertEqual(parsed_t["source_tracks"][0]["duration"], 268)

        pl_ent = {
            "type": "playlist",
            "name": "Late Night Drives",
            "trackList": [
                {"title": "Blinding Lights", "subtitle": "The\xa0Weeknd", "duration": 200040},
                {"title": "Starboy", "subtitle": "The\xa0Weeknd,\xa0Daft\xa0Punk", "duration": 230453},
            ],
        }
        parsed_p = _parse_spotify_embed_entity(pl_ent, "playlist")
        self.assertEqual(parsed_p["title"], "Late Night Drives")
        self.assertEqual(len(parsed_p["source_tracks"]), 2)
        self.assertEqual(parsed_p["source_tracks"][1]["artist"], "The Weeknd, Daft Punk")

        alb_ent = {
            "type": "album",
            "name": "After Hours",
            "subtitle": "The Weeknd",
            "trackList": [
                {"title": "Alone Again", "duration": 250000},
                {"title": "Snowchild", "artists": [{"name": "The Weeknd"}], "duration": 247000},
            ],
        }
        parsed_alb = _parse_spotify_embed_entity(alb_ent, "album")
        self.assertEqual(parsed_alb["source_tracks"][0]["artist"], "The Weeknd")
        self.assertEqual(parsed_alb["source_tracks"][1]["artist"], "The Weeknd")

    def test_parses_apple_serialized_server_data_without_related_pollution(self):
        payload = {
            "data": [
                {
                    "data": {
                        "sections": [
                            {
                                "id": "playlist-detail-header-section",
                                "itemKind": "containerDetailHeaderLockup",
                                "items": [{"title": "Today’s Hits"}],
                            },
                            {
                                "id": "track-list - pl.123",
                                "itemKind": "trackLockup",
                                "items": [
                                    {"title": "Blinding Lights", "artistName": "The Weeknd", "duration": 200000},
                                    {"title": "As It Was", "artistName": "Harry Styles", "duration": 167000},
                                ],
                            },
                            {
                                "id": "featured-artists",
                                "itemKind": "bubbleLockup",
                                "items": [{"title": "Should Ignore", "artistName": "Noise"}],
                            },
                        ]
                    }
                }
            ]
        }
        html_doc = (
            '<html><head><title>Ignored Title</title></head><body>'
            f'<script type="application/json" id="serialized-server-data">{json.dumps(payload)}</script>'
            "</body></html>"
        )
        title, tracks = _extract_apple_serialized_tracks(html_doc)
        self.assertEqual(title, "Today’s Hits")
        self.assertEqual(len(tracks), 2)
        self.assertEqual(tracks[0]["title"], "Blinding Lights")

        # Apple Music serialized-server-data can also have a top-level list root
        list_doc = (
            '<html><head><title>Ignored Title</title></head><body>'
            f'<script type="application/json" id="serialized-server-data">{json.dumps(payload["data"])}</script>'
            "</body></html>"
        )
        list_title, list_tracks = _extract_apple_serialized_tracks(list_doc)
        self.assertEqual(list_title, "Today’s Hits")
        self.assertEqual(len(list_tracks), 2)

    def test_youtube_matcher_penalizes_slowed_and_karaoke_variants(self):
        fake_yt = MagicMock()
        fake_yt.search.return_value = [
            {
                "videoId": "slowed11111",
                "title": "Blinding Lights (Slowed + Reverb)",
                "artists": [{"name": "The Weeknd"}],
                "duration_seconds": 238,
                "thumbnails": [],
            },
            {
                "videoId": "karaoke2222",
                "title": "Blinding Lights (Karaoke Instrumental)",
                "artists": [{"name": "The Weeknd"}],
                "duration_seconds": 200,
                "thumbnails": [],
            },
            {
                "videoId": "studio33333",
                "title": "Blinding Lights",
                "artists": [{"name": "The Weeknd"}],
                "duration_seconds": 200,
                "thumbnails": [],
            },
        ]

        matches = match_track_on_youtube(
            fake_yt,
            _format_track,
            {"title": "Blinding Lights", "artist": "The Weeknd", "duration": 200},
            max_results=1,
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["videoId"], "studio33333")

        # Word-boundary modifier check: "Discover" should not falsely trigger "cover"
        fake_yt.search.return_value = [
            {
                "videoId": "discover111",
                "title": "Discover Me",
                "artists": [{"name": "Artist"}],
                "duration_seconds": 195,
                "thumbnails": [],
            },
            {
                "videoId": "discover222",
                "title": "Discover Me (Lofi Remix)",
                "artists": [{"name": "Artist"}],
                "duration_seconds": 195,
                "thumbnails": [],
            },
        ]
        word_matches = match_track_on_youtube(
            fake_yt,
            _format_track,
            {"title": "Discover Me", "artist": "Artist", "duration": 195},
            max_results=1,
        )
        self.assertEqual(word_matches[0]["videoId"], "discover111")


class TestImportExternalAsync(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        IMPORT_CACHE.clear()

    async def test_import_apple_album_filters_ebooks_and_caches(self):
        itunes_json = {
            "resultCount": 3,
            "results": [
                {"wrapperType": "collection", "collectionName": "After Hours", "artistName": "The Weeknd"},
                {"wrapperType": None, "kind": "ebook", "trackName": "Wrong Book", "artistName": "Other"},
                {
                    "wrapperType": "track",
                    "kind": "song",
                    "trackId": 1499378117,
                    "trackName": "Blinding Lights",
                    "artistName": "The Weeknd",
                    "collectionName": "After Hours",
                    "trackTimeMillis": 200040,
                    "discNumber": 1,
                    "trackNumber": 9,
                },
            ],
        }
        mock_resp = httpx.Response(200, json=itunes_json)
        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=mock_resp)

        fake_yt = MagicMock()
        fake_yt.search.return_value = [
            {
                "videoId": "fHI8X4OXluQ",
                "title": "Blinding Lights",
                "artists": [{"name": "The Weeknd"}],
                "duration_seconds": 200,
                "thumbnails": [],
            }
        ]

        res1 = await import_external_url(
            mock_client,
            fake_yt,
            _format_track,
            "https://music.apple.com/us/album/after-hours/1499378108",
        )
        self.assertEqual(res1["provider"], "apple")
        self.assertEqual(res1["kind"], "album")
        self.assertEqual(res1["title"], "After Hours")
        self.assertEqual(len(res1["results"]), 1)
        self.assertEqual(res1["results"][0]["videoId"], "fHI8X4OXluQ")

        # Repeat call hits IMPORT_CACHE
        res2 = await import_external_url(
            mock_client,
            fake_yt,
            _format_track,
            "https://music.apple.com/us/album/after-hours/1499378108",
        )
        self.assertEqual(res2["results"][0]["videoId"], "fHI8X4OXluQ")
        self.assertEqual(mock_client.get.await_count, 1)

    async def test_short_link_blocks_unsafe_redirect(self):
        redirect_resp = httpx.Response(
            302,
            headers={"Location": "http://169.254.169.254/latest/meta-data"},
        )
        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=redirect_resp)
        fake_yt = MagicMock()

        with self.assertRaises(ValueError):
            await import_external_url(mock_client, fake_yt, _format_track, "https://spotify.link/badredirect")


if __name__ == "__main__":
    unittest.main()
