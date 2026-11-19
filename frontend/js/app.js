import { VibeScene3D } from "./scene3d.js?v=5";
import { LyricsEngine } from "./lyrics.js?v=5";

const STORAGE_KEY = "aura_playlists_v1";

const VIBE_PRESETS = {
  chill: { id: "chill", label: "Liquid Chill", particle_mode: "float", speed: 0.45, default_colors: ["#1e3a5f", "#4fd1c5", "#81e6d9"] },
  hype: { id: "hype", label: "Kinetic Hype", particle_mode: "burst", speed: 1.45, default_colors: ["#3b0764", "#f97316", "#facc15"] },
  synth: { id: "synth", label: "Neon Synth", particle_mode: "warp", speed: 1.15, default_colors: ["#0f0728", "#ec4899", "#06b6d4"] },
  melancholy: { id: "melancholy", label: "Velvet Rain", particle_mode: "rain", speed: 0.35, default_colors: ["#0f172a", "#38bdf8", "#94a3b8"] },
  rock: { id: "rock", label: "Molten Core", particle_mode: "embers", speed: 1.35, default_colors: ["#2a0606", "#ef4444", "#fb923c"] },
  romantic: { id: "romantic", label: "Golden Bloom", particle_mode: "stardust", speed: 0.55, default_colors: ["#3b0a2a", "#f43f5e", "#fda4af"] },
};

// Core DOM
const audio = document.getElementById("audio-player");
const searchInput = document.getElementById("search-input");
const clearSearchBtn = document.getElementById("clear-search");
const listHeading = document.getElementById("list-heading");
const trackListEl = document.getElementById("track-list");

const albumArt = document.getElementById("album-art");
const artPlaceholder = document.getElementById("art-placeholder");
const artContainer = document.getElementById("art-container");
const eqBars = Array.from(document.querySelectorAll("#cover-eq span"));
const trackTitleEl = document.getElementById("track-title");
const trackArtistEl = document.getElementById("track-artist");
const favBtn = document.getElementById("fav-btn");
const addToPlBtn = document.getElementById("add-to-pl-btn");

const playBtn = document.getElementById("play-btn");
const playIcon = document.getElementById("play-icon");
const pauseIcon = document.getElementById("pause-icon");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const seekBar = document.getElementById("seek-bar");
const volumeBar = document.getElementById("volume-bar");
const timeCurrent = document.getElementById("time-current");
const timeTotal = document.getElementById("time-total");
const syncBadge = document.getElementById("sync-badge");

const vibeLabel = document.getElementById("vibe-label");
const vibePills = document.getElementById("vibe-pills");
const offsetMinus = document.getElementById("offset-minus");
const offsetPlus = document.getElementById("offset-plus");
const offsetVal = document.getElementById("offset-val");
const immersionBtn = document.getElementById("immersion-btn");
const appShell = document.getElementById("app");

// Playlist DOM
const tabDiscover = document.getElementById("tab-discover");
const tabPlaylists = document.getElementById("tab-playlists");
const discoverPanel = document.getElementById("discover-panel");
const playlistsPanel = document.getElementById("playlists-panel");
const playlistHome = document.getElementById("playlist-home");
const playlistDetail = document.getElementById("playlist-detail");
const playlistsListEl = document.getElementById("playlists-list");
const newPlaylistBtn = document.getElementById("new-playlist-btn");
const toggleImportBtn = document.getElementById("toggle-import-btn");
const importBox = document.getElementById("import-box");
const importUrlInput = document.getElementById("import-url-input");
const importSubmitBtn = document.getElementById("import-submit-btn");
const importStatus = document.getElementById("import-status");
const plBackBtn = document.getElementById("pl-back-btn");
const plDetailName = document.getElementById("pl-detail-name");
const plDetailCount = document.getElementById("pl-detail-count");
const plPlayAllBtn = document.getElementById("pl-play-all-btn");
const plTracksListEl = document.getElementById("pl-tracks-list");

// Modal & Toast DOM
const playlistModal = document.getElementById("playlist-modal");
const modalTrackName = document.getElementById("modal-track-name");
const modalOptions = document.getElementById("modal-playlist-options");
const modalNewPlInput = document.getElementById("modal-new-pl-input");
const modalCreateBtn = document.getElementById("modal-create-btn");
const modalCloseBtn = document.getElementById("modal-close-btn");
const toastEl = document.getElementById("toast");

// Mobile Navigation & Mini-Player DOM
const mobileNav = document.getElementById("mobile-nav");
const mobileTabPlayer = document.getElementById("mobile-tab-player");
const mobileTabLyrics = document.getElementById("mobile-tab-lyrics");
const mobileTabDiscover = document.getElementById("mobile-tab-discover");
const mobileMiniPlayer = document.getElementById("mobile-mini-player");
const miniAlbumArt = document.getElementById("mini-album-art");
const miniTitle = document.getElementById("mini-title");
const miniArtist = document.getElementById("mini-artist");
const miniPlayBtn = document.getElementById("mini-play-btn");
const miniPlayIcon = document.getElementById("mini-play-icon");
const miniPauseIcon = document.getElementById("mini-pause-icon");
const miniProgressFill = document.getElementById("mini-progress-fill");
const mobileLyricsQuickBtn = document.getElementById("mobile-lyrics-quick-btn");
const lyricsBackBtn = document.getElementById("lyrics-back-btn");
const sidebarCloseBtn = document.getElementById("sidebar-close-btn");
const volMuteBtn = document.getElementById("vol-mute-btn");

let mobileView = "player";
let previousVolume = 0.85;

function setMobileView(view) {
  mobileView = view;
  appShell.setAttribute("data-mobile-view", view);

  mobileTabPlayer?.classList.toggle("active", view === "player");
  mobileTabLyrics?.classList.toggle("active", view === "lyrics");
  mobileTabDiscover?.classList.toggle("active", view === "discover");

  if (view === "player") {
    mobileMiniPlayer?.classList.add("hidden");
  } else {
    if (currentTrack) {
      mobileMiniPlayer?.classList.remove("hidden");
    }
  }

  if (view === "lyrics") {
    lyricsEngine.update(audio.currentTime || 0);
  }
}

// Engines
const scene3D = new VibeScene3D(document.getElementById("bg-canvas"));
const lyricsEngine = new LyricsEngine(
  document.getElementById("lyrics-viewport"),
  document.getElementById("lyrics-container"),
  (seconds) => {
    audio.currentTime = seconds;
  }
);

// App State
let discoverTracks = [];
let queue = [];
let currentIndex = -1;
let currentTrack = null;
let openPlaylistId = null;
let pendingTrackToAdd = null;

let isScrubbing = false;
let currentPalette = null;
let audioCtx = null;
let analyser = null;
let freqData = null;
let smoothBass = 0;
let smoothMid = 0;
let toastTimer = null;

// ================= PLAYLIST STORAGE =================
function loadPlaylists() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (Array.isArray(raw) && raw.length) return raw;
  } catch {
    // ignore corrupted storage
  }
  return [{ id: "favorites", name: "Favorites", tracks: [] }];
}

let playlists = loadPlaylists();

function savePlaylists() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(playlists));
}

function getPlaylist(id) {
  return playlists.find((p) => p.id === id);
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2400);
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

function formatTime(sec) {
  if (!sec || !Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function updateFavoriteButton() {
  const fav = getPlaylist("favorites");
  const isLiked = Boolean(currentTrack && fav?.tracks.some((t) => t.videoId === currentTrack.videoId));
  favBtn.classList.toggle("liked", isLiked);
}

function highlightPlayingRows() {
  document.querySelectorAll(".track-item[data-vid]").forEach((el) => {
    el.classList.toggle("active", Boolean(currentTrack && el.dataset.vid === currentTrack.videoId));
  });
}

// ================= WEB AUDIO & VISUALS =================
function initWebAudio() {
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return;
  }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
    const source = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  } catch (err) {
    console.warn("WebAudio init fallback:", err);
  }
}

artContainer.addEventListener("mousemove", (e) => {
  const rect = artContainer.getBoundingClientRect();
  const nx = (e.clientX - rect.left) / rect.width - 0.5;
  const ny = (e.clientY - rect.top) / rect.height - 0.5;
  artContainer.style.setProperty("--ry", `${(nx * 16).toFixed(2)}deg`);
  artContainer.style.setProperty("--rx", `${(-ny * 16).toFixed(2)}deg`);
});

artContainer.addEventListener("mouseleave", () => {
  artContainer.style.setProperty("--rx", "0deg");
  artContainer.style.setProperty("--ry", "0deg");
});

function applyVibe(vibeObj, keepAlbumColors = false) {
  const merged = { ...VIBE_PRESETS[vibeObj.id || "synth"], ...vibeObj };
  const colors = keepAlbumColors && currentPalette ? currentPalette : (merged.colors || merged.default_colors);
  merged.colors = colors;

  document.body.setAttribute("data-vibe", merged.id);
  document.documentElement.style.setProperty("--bg-base", colors[0]);
  document.documentElement.style.setProperty("--accent-1", colors[1]);
  document.documentElement.style.setProperty("--accent-2", colors[2]);

  vibeLabel.textContent = merged.label;
  vibePills.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.vibe === merged.id);
  });

  scene3D.setVibe(merged);
}

// ================= TRACK RENDERING & PLAYBACK =================
function createTrackRow(track, idx, sourceList, options = {}) {
  const row = document.createElement("div");
  row.className = "track-item";
  row.dataset.vid = track.videoId;
  if (currentTrack && currentTrack.videoId === track.videoId) row.classList.add("active");

  const actionSymbol = options.removable ? "&times;" : "+";
  const actionTitle = options.removable ? "Remove from playlist" : "Add to playlist";

  row.innerHTML = `
    <img src="${escapeHtml(track.thumbnail)}" referrerpolicy="no-referrer" alt="" loading="lazy"
         onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${escapeHtml(track.videoId)}/hqdefault.jpg';" />
    <div class="track-item-info">
      <div class="track-item-title">${escapeHtml(track.title)}</div>
      <div class="track-item-artist">${escapeHtml(track.artist)}</div>
    </div>
    <span class="track-item-dur">${escapeHtml(track.durationText || formatTime(track.duration))}</span>
    <button class="track-action-btn" title="${actionTitle}">${actionSymbol}</button>
  `;

  row.addEventListener("click", () => {
    queue = [...sourceList];
    playTrack(idx);
  });

  row.querySelector(".track-action-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (options.removable && options.playlistId) {
      removeTrackFromPlaylist(options.playlistId, track.videoId);
    } else {
      openAddModal(track);
    }
  });

  return row;
}

function renderDiscoverList(tracks) {
  discoverTracks = tracks;
  trackListEl.innerHTML = "";
  if (!tracks.length) {
    trackListEl.innerHTML = `<div class="skeleton-loader">No tracks found. Try another search.</div>`;
    return;
  }
  tracks.forEach((t, idx) => {
    trackListEl.appendChild(createTrackRow(t, idx, discoverTracks));
  });
}

async function playTrack(idx) {
  if (idx < 0 || idx >= queue.length) return;
  currentIndex = idx;
  const track = queue[idx];
  currentTrack = track;

  initWebAudio();
  lyricsEngine.resetOffset();
  offsetVal.textContent = "0.00s";
  highlightPlayingRows();
  updateFavoriteButton();

  trackTitleEl.textContent = track.title;
  trackArtistEl.textContent = track.artist;

  document.body.setAttribute("data-has-track", "true");
  if (miniAlbumArt) {
    miniAlbumArt.onerror = () => {
      miniAlbumArt.src = `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`;
    };
    miniAlbumArt.src = track.thumbnail;
  }
  if (miniTitle) miniTitle.textContent = track.title;
  if (miniArtist) miniArtist.textContent = track.artist;

  if (window.innerWidth <= 960 && mobileView === "discover") {
    setMobileView("player");
  } else if (mobileView !== "player") {
    mobileMiniPlayer?.classList.remove("hidden");
  }

  albumArt.onerror = () => {
    const fallback = `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`;
    if (albumArt.src !== fallback) albumArt.src = fallback;
  };
  albumArt.src = track.thumbnail;
  albumArt.classList.remove("hidden");
  artPlaceholder.classList.add("hidden");
  syncBadge.textContent = "SYNCING...";

  audio.src = `/api/stream/${encodeURIComponent(track.videoId)}`;
  audio.volume = parseFloat(volumeBar.value);
  audio.play().catch((err) => console.warn("Playback waiting for gesture:", err));

  try {
    const params = new URLSearchParams({
      title: track.title,
      artist: track.artist,
      duration: String(track.duration || 0),
      thumb: track.thumbnail,
    });
    const res = await fetch(`/api/track/${encodeURIComponent(track.videoId)}/meta?${params}`);
    const meta = await res.json();

    if (currentTrack?.videoId !== track.videoId) return;

    currentPalette = meta.vibe.colors;
    applyVibe(meta.vibe, false);
    lyricsEngine.load(meta.lyrics);

    if (meta.lyrics.word_native) syncBadge.textContent = "WORD SYNC";
    else if (meta.lyrics.synced) syncBadge.textContent = "SMART SYNC";
    else syncBadge.textContent = "PLAIN";
  } catch (err) {
    console.error("Metadata error:", err);
    syncBadge.textContent = "AUDIO ONLY";
  }
}

// ================= PLAYLIST UI & LOGIC =================
function switchTab(tab) {
  const isDiscover = tab === "discover";
  tabDiscover.classList.toggle("active", isDiscover);
  tabPlaylists.classList.toggle("active", !isDiscover);
  discoverPanel.classList.toggle("hidden", !isDiscover);
  playlistsPanel.classList.toggle("hidden", isDiscover);

  if (!isDiscover) {
    if (openPlaylistId && getPlaylist(openPlaylistId)) renderPlaylistDetail(openPlaylistId);
    else renderPlaylistsHome();
  }
}

tabDiscover.addEventListener("click", () => switchTab("discover"));
tabPlaylists.addEventListener("click", () => switchTab("playlists"));

function renderPlaylistsHome() {
  openPlaylistId = null;
  playlistHome.classList.remove("hidden");
  playlistDetail.classList.add("hidden");
  playlistsListEl.innerHTML = "";

  playlists.forEach((pl) => {
    const card = document.createElement("div");
    card.className = "playlist-card";
    const cover = pl.tracks[0]?.thumbnail;
    const isFav = pl.id === "favorites";

    card.innerHTML = `
      <div class="playlist-thumb">
        ${cover ? `<img src="${escapeHtml(cover)}" referrerpolicy="no-referrer" alt="" />` : (isFav ? "&#9829;" : "&#9835;")}
      </div>
      <div class="playlist-card-info">
        <div class="playlist-card-title">${escapeHtml(pl.name)}</div>
        <div class="playlist-card-sub">${pl.tracks.length} ${pl.tracks.length === 1 ? "song" : "songs"}</div>
      </div>
      ${isFav ? "" : `<button class="track-action-btn" title="Delete playlist">&times;</button>`}
    `;

    card.addEventListener("click", () => renderPlaylistDetail(pl.id));

    const delBtn = card.querySelector(".track-action-btn");
    if (delBtn) {
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm(`Delete playlist "${pl.name}"?`)) return;
        playlists = playlists.filter((p) => p.id !== pl.id);
        savePlaylists();
        renderPlaylistsHome();
        showToast(`Deleted "${pl.name}"`);
      });
    }

    playlistsListEl.appendChild(card);
  });
}

function renderPlaylistDetail(plId) {
  const pl = getPlaylist(plId);
  if (!pl) {
    renderPlaylistsHome();
    return;
  }

  openPlaylistId = plId;
  playlistHome.classList.add("hidden");
  playlistDetail.classList.remove("hidden");

  plDetailName.textContent = pl.name;
  plDetailCount.textContent = `${pl.tracks.length} ${pl.tracks.length === 1 ? "song" : "songs"}`;
  plTracksListEl.innerHTML = "";

  if (!pl.tracks.length) {
    plTracksListEl.innerHTML = `<div class="skeleton-loader">No songs yet. Click + on any track in Discover to add it here.</div>`;
    return;
  }

  pl.tracks.forEach((track, idx) => {
    plTracksListEl.appendChild(
      createTrackRow(track, idx, pl.tracks, { removable: true, playlistId: pl.id })
    );
  });
}

function addTrackToPlaylist(plId, track) {
  const pl = getPlaylist(plId);
  if (!pl) return;
  if (pl.tracks.some((t) => t.videoId === track.videoId)) {
    showToast(`Already in "${pl.name}"`);
    return;
  }
  pl.tracks.push({ ...track });
  savePlaylists();
  updateFavoriteButton();
  if (openPlaylistId === plId) renderPlaylistDetail(plId);
  showToast(`Added to "${pl.name}"`);
}

function removeTrackFromPlaylist(plId, videoId) {
  const pl = getPlaylist(plId);
  if (!pl) return;
  pl.tracks = pl.tracks.filter((t) => t.videoId !== videoId);
  savePlaylists();
  updateFavoriteButton();
  renderPlaylistDetail(plId);
  showToast(`Removed from "${pl.name}"`);
}

function createPlaylist(name, initialTracks = []) {
  const clean = name.trim();
  if (!clean) return null;
  const pl = {
    id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: clean,
    tracks: initialTracks,
  };
  playlists.push(pl);
  savePlaylists();
  return pl;
}

plBackBtn.addEventListener("click", renderPlaylistsHome);

plPlayAllBtn.addEventListener("click", () => {
  const pl = getPlaylist(openPlaylistId);
  if (!pl || !pl.tracks.length) {
    showToast("Playlist is empty");
    return;
  }
  queue = [...pl.tracks];
  playTrack(0);
});

newPlaylistBtn.addEventListener("click", () => {
  const name = prompt("New playlist name:");
  if (!name || !name.trim()) return;
  const pl = createPlaylist(name);
  if (pl) {
    renderPlaylistsHome();
    showToast(`Created "${pl.name}"`);
  }
});

toggleImportBtn.addEventListener("click", () => {
  importBox.classList.toggle("hidden");
  importStatus.classList.add("hidden");
  if (!importBox.classList.contains("hidden")) importUrlInput.focus();
});

async function runPlaylistImport() {
  const url = importUrlInput.value.trim();
  if (!url) return;

  importSubmitBtn.disabled = true;
  importStatus.textContent = "Importing playlist from YouTube...";
  importStatus.classList.remove("hidden");

  try {
    const res = await fetch(`/api/playlist?url=${encodeURIComponent(url)}`);
    const rawText = await res.text();
    let data = {};
    try { data = JSON.parse(rawText); } catch {}

    if (!res.ok) {
      throw new Error(data.detail || `Server error (${res.status}). Check Terminal.`);
    }

    const pl = createPlaylist(data.title || "Imported Playlist", data.results || []);
    importUrlInput.value = "";
    importBox.classList.add("hidden");
    importStatus.classList.add("hidden");
    renderPlaylistDetail(pl.id);
    showToast(`Imported ${pl.tracks.length} songs into "${pl.name}"`);
  } catch (err) {
    importStatus.textContent = err.message || "Could not import playlist.";
  } finally {
    importSubmitBtn.disabled = false;
  }
}

importSubmitBtn.addEventListener("click", runPlaylistImport);
importUrlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runPlaylistImport();
  }
});

// ================= ADD-TO-PLAYLIST MODAL =================
function openAddModal(track) {
  if (!track) {
    showToast("Play or pick a song first");
    return;
  }
  pendingTrackToAdd = track;
  modalTrackName.textContent = `${track.title} — ${track.artist}`;
  modalNewPlInput.value = "";
  modalOptions.innerHTML = "";

  playlists.forEach((pl) => {
    const btn = document.createElement("button");
    btn.className = "modal-pl-row";
    const exists = pl.tracks.some((t) => t.videoId === track.videoId);
    btn.innerHTML = `${escapeHtml(pl.name)} <span>${exists ? "Added" : `${pl.tracks.length} songs`}</span>`;
    btn.addEventListener("click", () => {
      addTrackToPlaylist(pl.id, pendingTrackToAdd);
      closeAddModal();
    });
    modalOptions.appendChild(btn);
  });

  playlistModal.classList.remove("hidden");
}

function closeAddModal() {
  playlistModal.classList.add("hidden");
  pendingTrackToAdd = null;
}

modalCloseBtn.addEventListener("click", closeAddModal);
playlistModal.addEventListener("click", (e) => {
  if (e.target === playlistModal) closeAddModal();
});

function createAndAddFromModal() {
  const name = modalNewPlInput.value.trim();
  if (!name || !pendingTrackToAdd) return;
  const pl = createPlaylist(name, [{ ...pendingTrackToAdd }]);
  if (pl) {
    updateFavoriteButton();
    if (!playlistsPanel.classList.contains("hidden") && !openPlaylistId) renderPlaylistsHome();
    showToast(`Created "${pl.name}" & added song`);
  }
  closeAddModal();
}

modalCreateBtn.addEventListener("click", createAndAddFromModal);
modalNewPlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    createAndAddFromModal();
  }
});

// Now Playing Favorite & Add-to-Playlist buttons
favBtn.addEventListener("click", () => {
  if (!currentTrack) return;
  const fav = getPlaylist("favorites");
  if (fav.tracks.some((t) => t.videoId === currentTrack.videoId)) {
    removeTrackFromPlaylist("favorites", currentTrack.videoId);
  } else {
    addTrackToPlaylist("favorites", currentTrack);
  }
});

addToPlBtn.addEventListener("click", () => openAddModal(currentTrack));

// ================= SEARCH & TRENDING =================
let searchTimer = null;
searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim();
  clearSearchBtn.classList.toggle("hidden", !q);
  clearTimeout(searchTimer);

  if (!q) {
    loadTrending();
    return;
  }

  searchTimer = setTimeout(async () => {
    listHeading.textContent = `YouTube Results for "${q}"`;
    trackListEl.innerHTML = `<div class="skeleton-loader">Searching YouTube...</div>`;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      renderDiscoverList(data.results || []);
    } catch {
      trackListEl.innerHTML = `<div class="skeleton-loader">Search failed. Check backend server.</div>`;
    }
  }, 420);
});

clearSearchBtn.addEventListener("click", () => {
  searchInput.value = "";
  clearSearchBtn.classList.add("hidden");
  loadTrending();
});

async function loadTrending() {
  listHeading.textContent = "Curated Spatial Mix";
  try {
    const res = await fetch("/api/trending");
    const data = await res.json();
    renderDiscoverList(data.results || []);
  } catch {
    trackListEl.innerHTML = `<div class="skeleton-loader">Start the FastAPI backend to browse YouTube.</div>`;
  }
}

// ================= TRANSPORT & CONTROLS =================
playBtn.addEventListener("click", () => {
  if (!audio.src && discoverTracks.length) {
    queue = [...discoverTracks];
    playTrack(0);
    return;
  }
  initWebAudio();
  if (audio.paused) audio.play();
  else audio.pause();
});

prevBtn.addEventListener("click", () => {
  if (audio.currentTime > 3) audio.currentTime = 0;
  else if (currentIndex > 0) playTrack(currentIndex - 1);
});

nextBtn.addEventListener("click", () => {
  if (currentIndex + 1 < queue.length) playTrack(currentIndex + 1);
});

audio.addEventListener("play", () => {
  playIcon.classList.add("hidden");
  pauseIcon.classList.remove("hidden");
  miniPlayIcon?.classList.add("hidden");
  miniPauseIcon?.classList.remove("hidden");
  artContainer.classList.add("playing");
});

audio.addEventListener("pause", () => {
  playIcon.classList.remove("hidden");
  pauseIcon.classList.add("hidden");
  miniPlayIcon?.classList.remove("hidden");
  miniPauseIcon?.classList.add("hidden");
  artContainer.classList.remove("playing");
});

audio.addEventListener("ended", () => {
  if (currentIndex + 1 < queue.length) playTrack(currentIndex + 1);
});

audio.addEventListener("error", (e) => {
  const errCode = audio.error ? audio.error.code : "unknown";
  console.error("Audio playback error:", e, "code:", errCode);
  syncBadge.textContent = "STREAM ERROR";
  showToast("Audio error loading track. Trying next song...");
  setTimeout(() => {
    if (currentIndex + 1 < queue.length) playTrack(currentIndex + 1);
  }, 2500);
});

seekBar.addEventListener("input", () => {
  isScrubbing = true;
  timeCurrent.textContent = formatTime(parseFloat(seekBar.value));
});

seekBar.addEventListener("change", () => {
  audio.currentTime = parseFloat(seekBar.value);
  isScrubbing = false;
});

volumeBar.addEventListener("input", () => {
  audio.volume = parseFloat(volumeBar.value);
});

vibePills.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-vibe]");
  if (!btn) return;
  const preset = VIBE_PRESETS[btn.dataset.vibe];
  if (preset) applyVibe(preset, false);
});

offsetMinus.addEventListener("click", () => {
  const val = lyricsEngine.setOffset(-0.25);
  offsetVal.textContent = `${val >= 0 ? "+" : ""}${val.toFixed(2)}s`;
});

offsetPlus.addEventListener("click", () => {
  const val = lyricsEngine.setOffset(0.25);
  offsetVal.textContent = `${val >= 0 ? "+" : ""}${val.toFixed(2)}s`;
});

immersionBtn.addEventListener("click", () => {
  const active = appShell.classList.toggle("cinema-mode");
  immersionBtn.textContent = active ? "Exit Cinema" : "Cinema Mode";
});

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.code === "Space") {
    e.preventDefault();
    playBtn.click();
  } else if (e.code === "ArrowRight") {
    audio.currentTime = audio.currentTime + 5;
  } else if (e.code === "ArrowLeft") {
    audio.currentTime = Math.max(0, audio.currentTime - 5);
  }
});

// ================= 60FPS SYNC LOOP =================
function mainLoop(now) {
  requestAnimationFrame(mainLoop);

  if (!audio.paused) {
    let bNorm = 0;
    let mNorm = 0;
    let hNorm = 0;

    if (analyser && freqData) {
      analyser.getByteFrequencyData(freqData);
      let bass = 0, mid = 0, high = 0;
      for (let i = 0; i < 8; i++) bass += freqData[i];
      for (let i = 8; i < 40; i++) mid += freqData[i];
      for (let i = 40; i < 100; i++) high += freqData[i];

      bNorm = bass / (8 * 255);
      mNorm = mid / (32 * 255);
      hNorm = high / (60 * 255);
    }

    const t = now * 0.004;
    const fftSilent = bNorm + mNorm + hNorm < 0.01;
    if (fftSilent) {
      bNorm = 0.25 + 0.2 * Math.abs(Math.sin(t));
      mNorm = 0.2 + 0.18 * Math.abs(Math.sin(t * 1.4 + 1));
      hNorm = 0.15 + 0.15 * Math.abs(Math.cos(t * 1.9));
    }

    smoothBass += (bNorm - smoothBass) * 0.28;
    smoothMid += (mNorm - smoothMid) * 0.22;

    scene3D.updateAudio(bNorm, mNorm, hNorm);
    artContainer.style.setProperty("--bass", smoothBass.toFixed(3));
    artContainer.style.setProperty("--mid", smoothMid.toFixed(3));

    const bins = [2, 6, 14, 26, 44];
    eqBars.forEach((bar, i) => {
      const level = fftSilent
        ? 0.25 + 0.65 * Math.abs(Math.sin(t * (1.2 + i * 0.35) + i))
        : Math.max(0.18, (freqData[bins[i]] || 0) / 255);
      bar.style.height = `${Math.round(level * 100)}%`;
    });
  } else {
    smoothBass *= 0.85;
    smoothMid *= 0.85;
    scene3D.updateAudio(0.05, 0.04, 0.02);
    artContainer.style.setProperty("--bass", smoothBass.toFixed(3));
    artContainer.style.setProperty("--mid", smoothMid.toFixed(3));
    eqBars.forEach((bar) => { bar.style.height = "22%"; });
  }

  const effectiveDuration =
    Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : (currentTrack?.duration || 0);

  if (effectiveDuration > 0) {
    seekBar.max = effectiveDuration;
    timeTotal.textContent = formatTime(effectiveDuration);
  }

  if (!isScrubbing && Number.isFinite(audio.currentTime)) {
    seekBar.value = audio.currentTime;
    timeCurrent.textContent = formatTime(audio.currentTime);
  }

  if (miniProgressFill && effectiveDuration > 0 && Number.isFinite(audio.currentTime)) {
    const pct = Math.min(100, Math.max(0, (audio.currentTime / effectiveDuration) * 100));
    miniProgressFill.style.width = `${pct.toFixed(2)}%`;
  }

  if (Number.isFinite(audio.currentTime) && (audio.currentTime > 0 || !audio.paused)) {
    lyricsEngine.update(audio.currentTime);
  }
}

// ================= MOBILE NAVIGATION & QUICK ACTIONS =================
function toggleMute() {
  if (audio.volume > 0) {
    previousVolume = audio.volume;
    audio.volume = 0;
    volumeBar.value = "0";
  } else {
    audio.volume = previousVolume || 0.85;
    volumeBar.value = String(audio.volume);
  }
}
volMuteBtn?.addEventListener("click", toggleMute);

mobileTabPlayer?.addEventListener("click", () => setMobileView("player"));
mobileTabLyrics?.addEventListener("click", () => setMobileView("lyrics"));
mobileTabDiscover?.addEventListener("click", () => setMobileView("discover"));
mobileLyricsQuickBtn?.addEventListener("click", () => setMobileView("lyrics"));
lyricsBackBtn?.addEventListener("click", () => setMobileView("player"));
sidebarCloseBtn?.addEventListener("click", () => setMobileView("player"));

mobileMiniPlayer?.addEventListener("click", () => setMobileView("player"));
miniPlayBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  playBtn.click();
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 960) {
    mobileMiniPlayer?.classList.add("hidden");
  } else {
    if (mobileView !== "player" && currentTrack) {
      mobileMiniPlayer?.classList.remove("hidden");
    }
  }
});

loadTrending();
requestAnimationFrame(mainLoop);