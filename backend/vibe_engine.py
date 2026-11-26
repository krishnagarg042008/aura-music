import colorsys
import io
import ipaddress
import re
from typing import Dict, List, Tuple
from urllib.parse import urlparse
import httpx
from PIL import Image

ALLOWED_THUMB_DOMAINS = (
    "ytimg.com",
    "youtube.com",
    "ggpht.com",
    "googleusercontent.com",
)
MAX_THUMB_BYTES = 5 * 1024 * 1024  # 5 MB safety limit


def is_allowed_thumbnail_url(url: str) -> bool:
    """Validate that a thumbnail URL points to HTTPS on a trusted YouTube/Google CDN."""
    if not url or not isinstance(url, str):
        return False
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return False

    if parsed.scheme.lower() != "https" or not parsed.hostname:
        return False

    host = parsed.hostname.lower().rstrip(".")
    if host in ("localhost", "localhost.localdomain"):
        return False

    # Reject raw IP addresses (IPv4 / IPv6 / metadata IPs)
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        pass

    return any(host == d or host.endswith(f".{d}") for d in ALLOWED_THUMB_DOMAINS)


VIBE_PROFILES: Dict[str, Dict] = {
    "chill": {
        "id": "chill",
        "label": "Liquid Chill",
        "geometry": "aurora_orb",
        "particle_mode": "float",
        "speed": 0.45,
        "turbulence": 0.65,
        "default_colors": ["#1e3a5f", "#4fd1c5", "#81e6d9"],
    },
    "hype": {
        "id": "hype",
        "label": "Kinetic Hype",
        "geometry": "bass_polyhedron",
        "particle_mode": "burst",
        "speed": 1.45,
        "turbulence": 1.85,
        "default_colors": ["#3b0764", "#f97316", "#facc15"],
    },
    "synth": {
        "id": "synth",
        "label": "Neon Synth",
        "geometry": "cyber_terrain",
        "particle_mode": "warp",
        "speed": 1.15,
        "turbulence": 1.1,
        "default_colors": ["#0f0728", "#ec4899", "#06b6d4"],
    },
    "melancholy": {
        "id": "melancholy",
        "label": "Velvet Rain",
        "geometry": "mist_prism",
        "particle_mode": "rain",
        "speed": 0.35,
        "turbulence": 0.45,
        "default_colors": ["#0f172a", "#38bdf8", "#94a3b8"],
    },
    "rock": {
        "id": "rock",
        "label": "Molten Core",
        "geometry": "plasma_spike",
        "particle_mode": "embers",
        "speed": 1.35,
        "turbulence": 2.1,
        "default_colors": ["#2a0606", "#ef4444", "#fb923c"],
    },
    "romantic": {
        "id": "romantic",
        "label": "Golden Bloom",
        "geometry": "velvet_torus",
        "particle_mode": "stardust",
        "speed": 0.55,
        "turbulence": 0.75,
        "default_colors": ["#3b0a2a", "#f43f5e", "#fda4af"],
    },
    "spiritual": {
        "id": "spiritual",
        "label": "Sacred Aura",
        "geometry": "sacred_lotus",
        "particle_mode": "diya",
        "speed": 0.40,
        "turbulence": 0.55,
        "default_colors": ["#1c0d04", "#f59e0b", "#fde68a"],
    },
    "cosmic": {
        "id": "cosmic",
        "label": "Cosmic Drift",
        "geometry": "astral_field",
        "particle_mode": "astral",
        "speed": 0.68,
        "turbulence": 0.85,
        "default_colors": ["#09051a", "#8b5cf6", "#38bdf8"],
    },
    "anime": {
        "id": "anime",
        "label": "Sakura Drift",
        "geometry": "sakura_breeze",
        "particle_mode": "sakura",
        "speed": 0.72,
        "turbulence": 0.90,
        "default_colors": ["#1b0b24", "#f472b6", "#38bdf8"],
    },
}

_JAPANESE_KANA_RE = re.compile(r"[\u3040-\u309F\u30A0-\u30FF]")

VIBE_KEYWORDS: Dict[str, List[str]] = {
    "spiritual": [
        "bhajan", "aarti", "chalisa", "mantra", "kirtan", "shabad", "gurbani",
        "waheguru", "satnam", "sufi", "qawwali", "kun faya", "maula", "khwaja",
        "ardas", "hanuman", "shiv", "shiva", "shambhu", "mahadev", "bholenath",
        "krishna", "radhe", "govind", "hare", "gayatri", "devotional", "sacred",
        "divine", "prayer", "worship", "hymn", "stotra", "tandav", "ram siya",
        "नमो", "राम", "शिव", "कृष्ण", "राधे", "हनुमान", "वाहेगुरु", "मौला",
        "नूर", "दुआ", "भजन", "आरती", "चालीसा", "सतनाम", "शंभू",
        "ਵਾਹਿਗੁਰੂ", "ਸਤਿਨਾਮ", "ਅਰਦਾਸ", "ਸ਼ਬਦ", "ਗੁਰਬਾਣੀ",
    ],
    "hype": [
        "rap", "hip hop", "trap", "phonk", "party", "club", "drill", "bass",
        "money", "millionaire", "gang", "lit", "rage", "remix", "honey singh",
        "travis scott", "kendrick", "drake", "eminem", "badshah", "kanye", "playboi",
        "bhangra", "jatt", "patiala", "peg", "gabru", "pendu", "dhol", "tauba",
        "295", "moose wala", "diljit", "karan aujla", "ap dhillon", "shubh",
        "ਜੱਟ", "ਪਟਿਆਲਾ",
    ],
    "synth": [
        "synth", "cyber", "neon", "electronic", "edm", "house", "techno", "dance",
        "blinding", "starboy", "daft punk", "weeknd", "midnight", "future", "disco",
        "vapor", "pulse", "electric", "laser", "retro", "80s", "synthwave",
    ],
    "melancholy": [
        "sad", "cry", "tears", "lonely", "alone", "broken", "rain", "goodbye",
        "hurt", "empty", "miss you", "memories", "fade", "dark", "sorrow", "pain",
        "blue", "melancholy", "slowed", "reverb", "billie", "radiohead", "adele",
        "bewafa", "judai", "tanhai", "dard", "aansu", "gham", "khamoshi", "udaas",
        "दर्द", "बेवफ़ा", "जुदाई", "आँसू", "तन्हाई", "उदास",
    ],
    "rock": [
        "rock", "metal", "punk", "guitar", "scream", "fire", "burn", "rebel",
        "thunder", "riot", "linkin park", "metallica", "nirvana", "queen",
        "arctic monkeys", "grunge", "heavy", "distortion", "war",
    ],
    "romantic": [
        "love", "heart", "dil", "pyaar", "ishq", "mehboob", "kiss", "forever",
        "darling", "baby", "sweet", "romance", "arijit", "kishore", "lata",
        "chura liya", "mohabbat", "soul", "valentine", "hold me", "angel",
        "sanam", "piya", "channa", "raataan", "kesariya", "humsafar", "sajna",
        "sohniye", "heeriye", "tere bina", "प्यार", "इश्क़", "मोहब्बत",
        "दिल", "सजना", "पिया", "हमसफ़र", "ਇਸ਼ਕ", "ਪਿਆਰ",
    ],
    "chill": [
        "lofi", "lo-fi", "chill", "acoustic", "ambient", "study", "sleep",
        "coffee", "breeze", "sunset", "ocean", "waves", "calm", "peace",
        "frank ocean", "sza", "jazz", "piano", "instrumental", "dream",
    ],
    "cosmic": [
        "cosmic", "galaxy", "universe", "interstellar", "nebula", "astral",
        "stardust", "cosmos", "orbital", "eclipse", "supernova", "moonlight",
        "stargazing", "space", "celestial", "constellation", "chaand", "चाँद", "ਤਾਰੇ",
    ],
    "anime": [
        "anime", "anime op", "anime ed", "j-pop", "jpop", "vocaloid", "yoasobi",
        "kenshi yonezu", "radwimps", "hiroyuki sawano", "sawano", "fujii kaze",
        "miki matsubara", "mariya takeuchi", "suzume", "your name", "kimi no na wa",
        "naruto", "one piece", "demon slayer", "kimetsu", "attack on titan",
        "shingeki", "jujutsu kaisen", "chainsaw man", "gurenge", "zankyosanka",
        "shinunoga", "hatsune miku", "city pop", "stay with me", "kaikai kitan",
        "cruel angel", "blue bird", "sakura", "night dancer", "imase",
    ],
}


def _rgb_to_hex(rgb: Tuple[int, int, int]) -> str:
    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"


def _color_vibrancy(rgb: Tuple[int, int, int]) -> float:
    r, g, b = [c / 255.0 for c in rgb]
    _, s, v = colorsys.rgb_to_hsv(r, g, b)
    # Favor saturated mid-to-bright colors over washed-out white or muddy black
    return (s ** 1.4) * (v * (1.15 - abs(v - 0.65)))


async def extract_palette(client: httpx.AsyncClient, image_url: str) -> List[str]:
    if not is_allowed_thumbnail_url(image_url):
        return ["#181828", "#6366f1", "#ec4899"]

    try:
        resp = await client.get(image_url, timeout=6.0)
        resp.raise_for_status()
        if len(resp.content) > MAX_THUMB_BYTES:
            return ["#121324", "#6366f1", "#38bdf8"]
        img = Image.open(io.BytesIO(resp.content)).convert("RGB")
        img = img.resize((96, 96))
        quantized = img.quantize(colors=10, method=Image.Quantize.MEDIANCUT)
        palette = quantized.getpalette()
        counts = quantized.getcolors()

        if not palette or not counts:
            return ["#181828", "#6366f1", "#ec4899"]

        candidates = []
        for count, idx in counts:
            rgb = (palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2])
            candidates.append((rgb, count, _color_vibrancy(rgb)))

        # Primary vibrant accent
        vibrant_sorted = sorted(candidates, key=lambda x: x[2], reverse=True)
        accent_1 = vibrant_sorted[0][0]

        # Secondary distinct vibrant accent
        accent_2 = vibrant_sorted[min(1, len(vibrant_sorted) - 1)][0]
        for rgb, _, _ in vibrant_sorted[1:]:
            dist = sum(abs(a - b) for a, b in zip(rgb, accent_1))
            if dist > 110:
                accent_2 = rgb
                break

        # Deep atmospheric base color derived from dominant tone (keep above 8-bit crush zone)
        r, g, b = [c / 255.0 for c in accent_1]
        h, s, _ = colorsys.rgb_to_hsv(r, g, b)
        base_rgb = tuple(int(c * 255) for c in colorsys.hsv_to_rgb(h, min(s, 0.75), 0.22))

        # Ensure accents are luminous enough for neon/glass highlights
        def boost(rgb_tuple: Tuple[int, int, int]) -> str:
            rr, gg, bb = [c / 255.0 for c in rgb_tuple]
            hh, ss, vv = colorsys.rgb_to_hsv(rr, gg, bb)
            boosted = colorsys.hsv_to_rgb(hh, max(ss, 0.55), max(vv, 0.72))
            return _rgb_to_hex(tuple(int(c * 255) for c in boosted))

        return [_rgb_to_hex(base_rgb), boost(accent_1), boost(accent_2)]
    except Exception:
        return ["#121324", "#6366f1", "#38bdf8"]


def classify_vibe(title: str, artist: str, lyrics_text: str = "") -> Dict:
    # Preserve ASCII words plus Devanagari, Gurmukhi, and Japanese Kana/CJK characters
    corpus = f"{title} {artist} {lyrics_text[:1500]}".lower()
    corpus = re.sub(r"[^\w\s\-\u0900-\u097F\u0A00-\u0A7F\u3040-\u30FF\u4E00-\u9FFF]", " ", corpus)

    scores: Dict[str, float] = {k: 0.0 for k in VIBE_PROFILES}
    meta_text = f"{title} {artist}".lower()

    if _JAPANESE_KANA_RE.search(meta_text):
        scores["anime"] += 4.5
    elif _JAPANESE_KANA_RE.search(lyrics_text[:1500]):
        scores["anime"] += 2.5

    for vibe, keywords in VIBE_KEYWORDS.items():
        for kw in keywords:
            if kw in meta_text:
                scores[vibe] += 3.5
            # Unicode Indic scripts don't always honor ASCII \b cleanly with combining matras;
            # use whitespace/punctuation lookarounds for reliable matching.
            matches = len(re.findall(rf"(?:^|\s){re.escape(kw)}(?=$|\s)", corpus))
            scores[vibe] += matches * 1.0

    best_vibe = max(scores, key=scores.get)
    if scores[best_vibe] < 1.5:
        fallback_order = ["synth", "chill", "romantic", "hype", "melancholy", "cosmic"]
        best_vibe = fallback_order[sum(ord(c) for c in title) % len(fallback_order)]

    return VIBE_PROFILES[best_vibe].copy()
