# ✦ AURA Music — Spatial 3D YouTube Music Player

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/krishnagarg042008/aura-music)

An immersive, spatial 3D music streaming experience built with **FastAPI** (Python backend) and a high-performance **WebGL Three.js visualizer with synchronized kinetic lyrics**.

---

## 🚀 1-Click Deploy on Render

Click the button above or visit:
👉 **[Deploy AURA on Render](https://render.com/deploy?repo=https://github.com/krishnagarg042008/aura-music)**

Render will automatically parse `render.yaml` and build the container using our production `Dockerfile` with `ffmpeg` pre-installed for seamless audio streaming.

---

## 📱 Mobile & Desktop Optimizations

- **Mobile View Router**: Bottom navigation bar with 1-thumb switching between **Player**, **Lyrics**, and **Explore**.
- **Floating Mini-Player**: Stays docked above navigation while exploring playlists or browsing lyrics with playback controls and real-time progress.
- **Dynamic Viewport (`100dvh`)**: Automatically handles iOS Safari and Android Chrome address bar expansion/collapse.
- **Safe Area Insets**: Native support for iPhone notch, Dynamic Island, and home indicator (`viewport-fit=cover`).
- **Touch Ergonomics**: 44×44px+ touch targets, zero tap lag (`touch-action: manipulation`), touch shockwaves, and volume mute toggle.
- **Adaptive GPU Profiles**: WebGL particle mesh automatically scales (420 particles on mobile vs 900 on desktop) and caps pixel ratio at 1.5× on phones to maintain locked 60 FPS without draining battery.
- **Desktop Cinema Mode & 3D Tilt**: Interactive 3D mouse tilt on album art, cinema mode collapsing sidebar, and keyboard shortcuts (`Space` play/pause, `←`/`→` seek 5s, `S` shuffle, `R` repeat, `[`/`]`/`\` lyrics sync).
- **Audio FX & Playback**: 5-band WebAudio EQ, loudness normalization, dual-deck crossfading, Shuffle, Repeat (`Off`/`Queue`/`Track`), Endless Auto-Radio, and OS Media Session lock-screen controls.
- **Lyrics & Share Cards**: Custom LRC/plain lyrics paste per track and 1080×1350 PNG lyric quote card export/sharing.
- **Installable PWA & Backups**: Offline shell Service Worker, Web App Manifest, and JSON library export/restore.

---

## 🛠️ Stack & Architecture

- **Backend**: FastAPI, Uvicorn, ytmusicapi, yt-dlp, HTTPX, Pillow, PyYAML (with bounded TTL caches, single-flight stream resolution, SSRF thumbnail allowlist, and rate limiting).
- **Frontend**: Vanilla ES Modules, Three.js WebGL (6 vibe-matched 3D geometries, GPU particle shader, FBM backdrop), WebAudio EQ/Compressor, CSS Glassmorphism.
- **Container**: Multi-stage `Dockerfile` (Python 3.12-slim + ffmpeg).

---

## 💻 Local Development

```bash
# 1. Clone repository
git clone https://github.com/krishnagarg042008/aura-music.git
cd aura-music

# 2. Install dependencies
pip install -r requirements.txt

# 3. Start development / production server
./start.sh
```

### Environment Variables & Tests

- `AURA_CORS_ORIGINS` — Comma-separated allowed CORS origins (defaults to `*`).
- `AURA_RATE_LIMIT_ENABLED` — Set to `0` or `false` to disable API rate limiting (defaults to enabled).

```bash
# Run Python unit & API tests
.venv/bin/python -m unittest discover -s tests -v

# Run frontend ES module tests
node --test tests/test_frontend.mjs
```

- **Desktop**: Open `http://localhost:8000`
- **Mobile (Same Wi-Fi)**: Open `http://<YOUR_LOCAL_IP>:8000`
