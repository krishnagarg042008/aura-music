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
- **Desktop Cinema Mode & 3D Tilt**: Interactive 3D mouse tilt on album art, cinema mode collapsing sidebar, and keyboard shortcuts (`Space` to toggle playback, `←`/`→` to scrub 5s).

---

## 🛠️ Stack & Architecture

- **Backend**: FastAPI, Uvicorn, ytmusicapi, yt-dlp, HTTPX, Pillow, PyYAML.
- **Frontend**: Vanilla ES Modules, Three.js WebGL (custom FBM liquid mesh & particle shader), CSS Glassmorphism.
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

- **Desktop**: Open `http://localhost:8000`
- **Mobile (Same Wi-Fi)**: Open `http://<YOUR_LOCAL_IP>:8000`
