import io
import unittest
from unittest.mock import AsyncMock, MagicMock

from PIL import Image

from backend.vibe_engine import classify_vibe, extract_palette, is_allowed_thumbnail_url


class TestVibeEngine(unittest.TestCase):
    def test_thumbnail_url_allowlist_blocks_ssrf(self):
        self.assertTrue(is_allowed_thumbnail_url("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"))
        self.assertTrue(is_allowed_thumbnail_url("https://lh3.googleusercontent.com/abc=w1000-h1000"))
        self.assertTrue(is_allowed_thumbnail_url("https://yt3.ggpht.com/xyz"))

        self.assertFalse(is_allowed_thumbnail_url(""))
        self.assertFalse(is_allowed_thumbnail_url("http://i.ytimg.com/vi/abc/hqdefault.jpg"))
        self.assertFalse(is_allowed_thumbnail_url("https://169.254.169.254/latest/meta-data"))
        self.assertFalse(is_allowed_thumbnail_url("https://127.0.0.1:8000/secret"))
        self.assertFalse(is_allowed_thumbnail_url("https://localhost/internal"))
        self.assertFalse(is_allowed_thumbnail_url("https://[::1]/secret"))
        self.assertFalse(is_allowed_thumbnail_url("https://evil-ytimg.com/hack.jpg"))

    def test_classify_vibe_keywords(self):
        self.assertEqual(classify_vibe("Blinding Lights", "The Weeknd")["id"], "synth")
        self.assertEqual(classify_vibe("Numb", "Linkin Park")["id"], "rock")
        self.assertEqual(classify_vibe("Lofi Chill Beats", "Study")["id"], "chill")
        self.assertEqual(classify_vibe("Love Story", "Romantic")["id"], "romantic")

    def test_classify_vibe_spiritual_cosmic_and_hindi_punjabi(self):
        self.assertEqual(classify_vibe("Shree Hanuman Chalisa", "Hariharan")["id"], "spiritual")
        self.assertEqual(
            classify_vibe("Kun Faya Kun", "A.R. Rahman", "मौला मोरे घर आ जा नूर ही नूर")["id"],
            "spiritual",
        )
        self.assertEqual(classify_vibe("Track 1", "Singer", "ਵਾਹਿਗੁਰੂ ਸਤਿਨਾਮ ਅਰਦਾਸ")["id"], "spiritual")
        self.assertEqual(classify_vibe("Interstellar Cosmic Nebula", "Space")["id"], "cosmic")
        self.assertEqual(classify_vibe("Brown Munde", "AP Dhillon")["id"], "hype")
        self.assertEqual(classify_vibe("Kesariya", "Arijit Singh", "केसरिया तेरा इश्क़ है पिया")["id"], "romantic")

    def test_classify_anime_vibe_and_avoids_false_positives(self):
        self.assertEqual(classify_vibe("Idol", "YOASOBI")["id"], "anime")
        self.assertEqual(classify_vibe("Suzume", "RADWIMPS")["id"], "anime")
        self.assertEqual(classify_vibe("Night Track", "Artist", "夢の中で君を探していた")["id"], "anime")

        # Short substrings ("ost", "eve", "ado") must not leak into unrelated English titles
        self.assertNotEqual(classify_vibe("Lost Forever", "Shadow Band")["id"], "anime")


class TestExtractPalette(unittest.IsolatedAsyncioTestCase):
    async def test_extract_palette_rejects_disallowed_url_without_http(self):
        client = MagicMock()
        client.get = AsyncMock()
        colors = await extract_palette(client, "http://169.254.169.254/latest/meta-data")
        self.assertEqual(len(colors), 3)
        client.get.assert_not_awaited()

    async def test_extract_palette_extracts_three_hex_colors(self):
        img = Image.new("RGB", (64, 64), color=(230, 60, 140))
        buf = io.BytesIO()
        img.save(buf, format="PNG")

        resp = MagicMock()
        resp.content = buf.getvalue()
        resp.raise_for_status = MagicMock()

        client = MagicMock()
        client.get = AsyncMock(return_value=resp)

        colors = await extract_palette(client, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")
        self.assertEqual(len(colors), 3)
        for col in colors:
            self.assertRegex(col, r"^#[0-9a-f]{6}$")


if __name__ == "__main__":
    unittest.main()
