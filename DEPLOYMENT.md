# 🚀 AURA Music — Production Deployment Guide

AURA Music is a unified full-stack application built with **FastAPI** (Python backend) and a high-performance **3D spatial WebGL audio visualizer with word-by-word synchronized lyrics** (Frontend).

The app is responsive and optimized for both **Desktop** and **Mobile Phones** (iOS Safari, Android Chrome, Tablets).

---

## 📱 Mobile & Desktop Optimizations Included

- **Mobile Viewport (`100dvh`)**: Adapts dynamically to browser address bars on iOS and Android.
- **Mobile Bottom Navigation Bar**: Easy one-thumb switching between:
  - 🎵 **Player** (Album art visualizer, scrubber, transport controls, favorite & playlist management)
  - 📝 **Lyrics** (Full-screen kinetic typography with word-level sync and tap-to-seek)
  - 🔍 **Explore** (YouTube catalog search, trending tracks, playlists, and playlist import)
- **Floating Mini-Player**: When browsing YouTube search results, playlists, or reading lyrics on mobile, a floating mini-player keeps music controls, track info, and playback progress docked at your fingertips.
- **Touch-Optimized Controls**: Meets Apple & Google 44x44px minimum touch target guidelines with zero tap delay.
- **3D WebGL Scene Adaptive Performance**: Automatic device pixel ratio capping and particle scaling (`420` on mobile vs `900` on desktop) ensuring 60fps performance without draining phone battery.
- **Safe Area Insets**: Native support for iPhone notch, Dynamic Island, and home bar (`viewport-fit=cover`, `env(safe-area-inset-*)`).
- **Desktop Cinema Mode & Wide Layouts**: Clean 3-pane / 2-pane split on desktop, cinema mode collapsing sidebar, 3D mouse tilt on album art, and keyboard navigation (`Space` to toggle play, arrow keys to seek).

---

## ⚡ Deployment Options

### Option 1: 1-Click Free Cloud Deployment with Render (Recommended)

1. Push this repository to **GitHub** or **GitLab** (see Git setup below).
2. Go to [render.com](https://render.com) and log in.
3. Click **New +** &rarr; **Web Service**.
4. Connect your `aura-music` GitHub repository.
5. Render will automatically detect `render.yaml` or you can specify:
   - **Environment**: `Python`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `python run.py`
   - **Health Check Path**: `/health`
6. Click **Create Web Service**. Your live HTTPS URL (e.g. `https://aura-music.onrender.com`) will be active in ~2 minutes!

---

### Option 2: Deploy to Railway

1. Install the Railway CLI or connect via the web dashboard at [railway.app](https://railway.app).
2. Click **New Project** &rarr; **Deploy from GitHub repo**.
3. Select this repository.
4. Railway will automatically pick up the included `Dockerfile` and `railway.json`.
5. Under Settings, generate a public domain (e.g. `https://aura-music.up.railway.app`).

---

### Option 3: Deploy to Fly.io

1. Install Flyctl: `curl -L https://fly.io/install.sh | sh`
2. Run `fly launch` in the project root.
3. Fly.io uses the included `fly.toml` and `Dockerfile`.
4. Run `fly deploy`.

---

### Option 4: Deploy with Docker (Any VPS / Cloud Provider / DigitalOcean / AWS / GCP)

Build and run anywhere with Docker:

```bash
# 1. Build the production Docker image
docker build -t aura-music .

# 2. Run container (mapped to port 8000)
docker run -d -p 8000:8000 --name aura-music-app --restart always aura-music
```

Visit `http://YOUR_SERVER_IP:8000` in your browser.

---

### Option 5: Test on Mobile Phone Locally (Same Wi-Fi)

You can run the production server locally right now and open it on your phone:

```bash
# Start the server
chmod +x start.sh
./start.sh
```

- On your computer: Open `http://localhost:8000`
- On your mobile phone (connected to same Wi-Fi):
  Open `http://<YOUR_LOCAL_IP>:8000` (e.g., `http://10.12.43.56:8000`).

---

## 🛠️ Project Structure

```
aura-music/
├── backend/
│   ├── lyrics_engine.py   # Synchronized lyrics fetcher & parser
│   ├── vibe_engine.py     # Palette extractor & vibe classifier
│   └── main.py            # FastAPI ASGI backend & static server
├── frontend/
│   ├── css/
│   │   └── styles.css     # Responsive glassmorphic styles (Mobile & Desktop)
│   ├── js/
│   │   ├── app.js         # Mobile nav, mini-player & playback coordinator
│   │   ├── lyrics.js      # Synchronized kinetic lyrics renderer
│   │   └── scene3d.js     # Responsive Three.js audio-reactive 3D scene
│   └── index.html         # Semantic HTML5 entrypoint with safe-area viewport
├── Dockerfile             # Multi-stage production container with ffmpeg
├── .dockerignore
├── .gitignore
├── Procfile               # Standard PaaS process definition
├── render.yaml            # Render infrastructure-as-code
├── railway.json           # Railway deployment config
├── fly.toml               # Fly.io deployment config
├── requirements.txt       # Python dependencies
├── run.py                 # Production runner ($PORT / $HOST support)
└── start.sh               # Local launch script
```
