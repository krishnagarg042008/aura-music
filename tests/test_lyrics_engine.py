import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from backend.lyrics_engine import (
    LYRICS_CACHE,
    _split_artist_candidates,
    clean_track_title,
    detect_indic_script,
    fetch_synced_lyrics,
    is_valid_match,
    parse_lrc,
    parse_lyricsfile_yaml,
)


class TestLyricsCleaningAndValidation(unittest.TestCase):
    def test_clean_track_title_strips_youtube_noise(self):
        self.assertEqual(
            clean_track_title("Blinding Lights (Official Video) | The Weeknd"),
            "Blinding Lights",
        )
        self.assertEqual(
            clean_track_title("Starboy [4K Remaster] feat. Daft Punk"),
            "Starboy",
        )
        self.assertEqual(
            clean_track_title("O Maahi (Lyrical Video) | Dunki | Arijit Singh | T-Series"),
            "O Maahi",
        )
        self.assertEqual(
            clean_track_title("3 Peg - Full Video - Speed Records"),
            "3 Peg",
        )
        self.assertEqual(
            clean_track_title("Kesariya Full Song Sony Music India"),
            "Kesariya",
        )
        # Preserve legitimate words inside real titles
        self.assertEqual(
            clean_track_title("Video Games (Remastered)"),
            "Video Games",
        )

    def test_split_artist_candidates_and_label_filtering(self):
        self.assertEqual(
            _split_artist_candidates("Pritam, Arijit Singh, Amitabh Bhattacharya"),
            ["Pritam", "Arijit Singh", "Amitabh Bhattacharya"],
        )
        self.assertEqual(
            _split_artist_candidates("Sharry Maan; Mista Baaz; Ravi Raj"),
            ["Sharry Maan", "Mista Baaz", "Ravi Raj"],
        )
        self.assertEqual(
            _split_artist_candidates("DEVI SRI PRASAD (DSP)"),
            ["DEVI SRI PRASAD", "DSP"],
        )
        self.assertEqual(
            _split_artist_candidates("T-Series"),
            [],
        )

    def test_detect_indic_script(self):
        self.assertEqual(detect_indic_script("मुझको इतना बताए कोई"), "devanagari")
        self.assertEqual(detect_indic_script("ਦੱਸ ਪੁੱਤ, ਤੇਰਾ head down ਕਾਸਤੋਂ?"), "gurmukhi")
        self.assertEqual(detect_indic_script("ਤੇਰੀ-ਮੇਰੀ ਗੱਲਾਂ\nकर ना कभी तू"), "mixed")
        self.assertEqual(detect_indic_script("I'm tryna put you in the worst mood"), "latin")

    def test_is_valid_match_accepts_alternate_artist_splits(self):
        ok, score = is_valid_match(
            query_title="Kesariya (Full Video) | Sony Music India",
            query_artist="Pritam, Arijit Singh",
            cand_title="Kesariya",
            cand_artist="Arijit Singh",
            query_dur=268,
            cand_dur=268,
        )
        self.assertTrue(ok)
        self.assertGreater(score, 0.8)

    def test_is_valid_match_rejects_different_artist_and_duration(self):
        ok, _ = is_valid_match(
            query_title="Pushpa Pushpa",
            query_artist="Devi Sri Prasad",
            cand_title="Pushpa",
            cand_artist="Aphex Twin",
            query_dur=240,
            cand_dur=240,
        )
        self.assertFalse(ok)

        ok_dur, _ = is_valid_match(
            query_title="Blinding Lights",
            query_artist="The Weeknd",
            cand_title="Blinding Lights",
            cand_artist="The Weeknd",
            query_dur=200,
            cand_dur=320,
        )
        self.assertFalse(ok_dur)

    def test_is_valid_match_handles_unicode_and_diacritics(self):
        # Devanagari should stay intact and reject mismatches
        ok_hi, _ = is_valid_match(
            query_title="केसरिया",
            query_artist="अरिजीत सिंह",
            cand_title="केसरिया",
            cand_artist="अरिजीत सिंह",
        )
        self.assertTrue(ok_hi)

        bad_hi, _ = is_valid_match(
            query_title="केसरिया",
            query_artist="अरिजीत सिंह",
            cand_title="अलग गाना",
            cand_artist="अरिजीत सिंह",
        )
        self.assertFalse(bad_hi)

        # Japanese CJK
        ok_jp, _ = is_valid_match(
            query_title="夜に駆ける",
            query_artist="YOASOBI",
            cand_title="夜に駆ける",
            cand_artist="YOASOBI",
        )
        self.assertTrue(ok_jp)

        # Latin diacritic folding
        ok_lat, _ = is_valid_match(
            query_title="Été 99",
            query_artist="Anaïs",
            cand_title="Ete 99",
            cand_artist="Anais",
        )
        self.assertTrue(ok_lat)

        # Single-char title must not match unrelated tracks
        bad_single, _ = is_valid_match(
            query_title="U",
            query_artist="Kendrick Lamar",
            cand_title="Alright",
            cand_artist="Kendrick Lamar",
        )
        self.assertFalse(bad_single)


class TestLrcAndYamlParsing(unittest.TestCase):
    def test_parse_lrc_skips_headers_including_fullwidth_and_spaced_colons(self):
        lrc = (
            "[00:00.00] 作词 : Test Writer\n"
            "[00:00.50] Producer：Someone\n"
            "[00:01.00] Artist : Demo\n"
            "[00:10.00] First real lyric line\n"
            "[00:14.50] Second real lyric line\n"
        )
        lines = parse_lrc(lrc, track_duration=180.0)
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["text"], "First real lyric line")
        self.assertEqual(lines[1]["start"], 14.5)

    def test_parse_enhanced_lrc_words(self):
        lrc = "[00:05.00] <00:05.10>Hello <00:05.60>spatial <00:06.20>world"
        lines = parse_lrc(lrc, track_duration=120.0)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["text"], "Hello spatial world")
        self.assertEqual(len(lines[0]["words"]), 3)
        self.assertEqual(lines[0]["words"][1]["start"], 5.6)

    def test_parse_lyricsfile_yaml(self):
        raw_yaml = (
            "lines:\n"
            "  - text: Shine bright\n"
            "    start_ms: 1000\n"
            "    end_ms: 3000\n"
            "    words:\n"
            "      - text: Shine\n"
            "        start_ms: 1000\n"
            "        end_ms: 1800\n"
            "      - text: bright\n"
            "        start_ms: 1900\n"
            "        end_ms: 3000\n"
        )
        lines = parse_lyricsfile_yaml(raw_yaml)
        self.assertIsNotNone(lines)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["words"][0]["text"], "Shine")
        self.assertEqual(lines[0]["words"][1]["end"], 3.0)


class TestFetchSyncedLyrics(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        LYRICS_CACHE.clear()

    async def test_fetch_synced_lyrics_uses_lrclib_exact_and_cache(self):
        resp_exact = MagicMock()
        resp_exact.status_code = 200
        resp_exact.json.return_value = {
            "syncedLyrics": "[00:02.00] Midnight neon sky\n[00:06.00] Dancing in the light",
            "plainLyrics": "Midnight neon sky\nDancing in the light",
        }

        client = MagicMock()
        client.get = AsyncMock(return_value=resp_exact)

        res1 = await fetch_synced_lyrics(client, "Neon Sky", "Synth Artist", 180, video_id="vid12345678")
        self.assertTrue(res1["synced"])
        self.assertEqual(len(res1["lines"]), 2)
        self.assertEqual(client.get.await_count, 1)

        # Second call hits LYRICS_CACHE without HTTP
        res2 = await fetch_synced_lyrics(client, "Neon Sky", "Synth Artist", 180, video_id="vid12345678")
        self.assertEqual(res1, res2)
        self.assertEqual(client.get.await_count, 1)

    async def test_fetch_synced_lyrics_falls_back_to_plain_without_fake_sync(self):
        resp_404 = MagicMock()
        resp_404.status_code = 404
        resp_404.json.return_value = {}

        resp_ovh = MagicMock()
        resp_ovh.status_code = 200
        resp_ovh.json.return_value = {"lyrics": "[Verse 1]\nLine one\nLine two"}

        async def mock_get(url, **kwargs):
            if "lyrics.ovh" in url:
                return resp_ovh
            return resp_404

        client = MagicMock()
        client.get = AsyncMock(side_effect=mock_get)

        with patch("backend.lyrics_engine._fetch_ytmusic_lyrics_sync", return_value=None):
            res = await fetch_synced_lyrics(client, "Unknown Song", "Artist", 200, video_id="vid87654321")

        self.assertFalse(res["synced"])
        self.assertEqual([l["text"] for l in res["lines"]], ["Line one", "Line two"])

    async def test_fetch_synced_lyrics_retries_alternate_artist_split_and_detects_indic(self):
        resp_404 = MagicMock()
        resp_404.status_code = 404
        resp_404.json.return_value = {}

        resp_arijit = MagicMock()
        resp_arijit.status_code = 200
        resp_arijit.json.return_value = {
            "syncedLyrics": "[00:09.44] मुझको इतना बताए कोई\n[00:19.02] कैसे तुझसे दिल ना लगाए कोई?",
            "plainLyrics": "मुझको इतना बताए कोई\nकैसे तुझसे दिल ना लगाए कोई?",
        }

        async def mock_get(url, params=None, **kwargs):
            if url.endswith("/api/get") and params and params.get("artist_name") == "Arijit Singh":
                return resp_arijit
            return resp_404

        client = MagicMock()
        client.get = AsyncMock(side_effect=mock_get)

        res = await fetch_synced_lyrics(
            client,
            "Kesariya (Full Video) | Brahmāstra | Sony Music India",
            "Pritam, Arijit Singh",
            268,
            video_id="BddP6PYo2gs",
        )
        self.assertTrue(res["synced"])
        self.assertEqual(res["script"], "devanagari")
        self.assertEqual(res["lines"][0]["text"], "मुझको इतना बताए कोई")


if __name__ == "__main__":
    unittest.main()
