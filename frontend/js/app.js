import { VibeScene3D } from "./scene3d.js?v=18";
import { LyricsEngine, renderLyricCardBlob } from "./lyrics.js?v=17";
import { buildShuffledQueue, detectExternalMusicUrl, isLocalOrLanHostname, parseClientLrc } from "./lrc-utils.js?v=19";

const STORAGE_KEY = "aura_playlists_v1";
const HISTORY_KEY = "aura_listen_history_v1";
const QUEUE_KEY = "aura_queue_v1";
const QUEUE_IDX_KEY = "aura_queue_idx_v1";
const PREFS_KEY = "aura_prefs_v1";
const SCRIPT_MODE_KEY = "aura_lyrics_script_mode_v1";

const VIBE_PRESETS = {
  chill: { id: "chill", label: "Liquid Chill", particle_mode: "float", speed: 0.45, turbulence: 0.65, default_colors: ["#1e3a5f", "#4fd1c5", "#81e6d9"] },
  hype: { id: "hype", label: "Kinetic Hype", particle_mode: "burst", speed: 1.45, turbulence: 1.85, default_colors: ["#3b0764", "#f97316", "#facc15"] },
  synth: { id: "synth", label: "Neon Synth", particle_mode: "warp", speed: 1.15, turbulence: 1.1, default_colors: ["#0f0728", "#ec4899", "#06b6d4"] },
  melancholy: { id: "melancholy", label: "Velvet Rain", particle_mode: "rain", speed: 0.35, turbulence: 0.45, default_colors: ["#0f172a", "#38bdf8", "#94a3b8"] },
  rock: { id: "rock", label: "Molten Core", particle_mode: "embers", speed: 1.35, turbulence: 2.1, default_colors: ["#2a0606", "#ef4444", "#fb923c"] },
  romantic: { id: "romantic", label: "Golden Bloom", particle_mode: "stardust", speed: 0.55, turbulence: 0.75, default_colors: ["#3b0a2a", "#f43f5e", "#fda4af"] },
  spiritual: { id: "spiritual", label: "Sacred Aura", particle_mode: "diya", speed: 0.40, turbulence: 0.55, default_colors: ["#1c0d04", "#f59e0b", "#fde68a"] },
  cosmic: { id: "cosmic", label: "Cosmic Drift", particle_mode: "astral", speed: 0.68, turbulence: 0.85, default_colors: ["#09051a", "#8b5cf6", "#38bdf8"] },
};

const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  bass: [6, 4, 0, 1, 2],
  vocal: [-2, -1, 4, 4, 1],
  electronic: [5, 2, -1, 3, 5],
  night: [-3, 2, 3, -1, -3],
};

// Core Audio Decks (Dual-deck for seamless WebAudio crossfading)
const audioA = document.getElementById("audio-player");
const audioB = document.getElementById("audio-player-b");
let activeDeck = audioA;
let inactiveDeck = audioB;

// DOM References
const searchInput = document.getElementById("search-input");
const clearSearchBtn = document.getElementById("clear-search");
const listHeading = document.getElementById("list-heading");
const trackListEl = document.getElementById("track-list");
const extImportBanner = document.getElementById("external-import-banner");
const extBannerBadge = document.getElementById("ext-banner-badge");
const extBannerInfo = document.getElementById("ext-banner-info");
const extPlayAllBtn = document.getElementById("ext-play-all-btn");
const extQueueAllBtn = document.getElementById("ext-queue-all-btn");
const extSavePlBtn = document.getElementById("ext-save-pl-btn");

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
const shuffleBtn = document.getElementById("shuffle-btn");
const repeatBtn = document.getElementById("repeat-btn");
const repeatOneBadge = document.getElementById("repeat-one-badge");
const autoRadioBtn = document.getElementById("autoradio-btn");
const seekBar = document.getElementById("seek-bar");
const volumeBar = document.getElementById("volume-bar");
const timeCurrent = document.getElementById("time-current");
const timeTotal = document.getElementById("time-total");
const syncBadge = document.getElementById("sync-badge");

const vibeLabel = document.getElementById("vibe-label");
const vibePills = document.getElementById("vibe-pills");
const offsetVal = document.getElementById("offset-val");
const immersionBtn = document.getElementById("immersion-btn");
const cinemaHud = document.getElementById("cinema-hud");
const cinemaExitBtn = document.getElementById("cinema-exit-btn");
const cinemaFsBtn = document.getElementById("cinema-fs-btn");
const appShell = document.getElementById("app");

// Playlist & Backup DOM
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
const exportLibraryBtn = document.getElementById("export-library-btn");
const importLibraryBtn = document.getElementById("import-library-btn");
const importLibraryFile = document.getElementById("import-library-file");

// Modals & Toast DOM
const playlistModal = document.getElementById("playlist-modal");
const modalTrackName = document.getElementById("modal-track-name");
const modalOptions = document.getElementById("modal-playlist-options");
const modalNewPlInput = document.getElementById("modal-new-pl-input");
const modalCreateBtn = document.getElementById("modal-create-btn");
const modalCloseBtn = document.getElementById("modal-close-btn");
const toastEl = document.getElementById("toast");

const dialogModal = document.getElementById("dialog-modal");
const dialogTitle = document.getElementById("dialog-title");
const dialogMessage = document.getElementById("dialog-message");
const dialogInput = document.getElementById("dialog-input");
const dialogCancelBtn = document.getElementById("dialog-cancel-btn");
const dialogConfirmBtn = document.getElementById("dialog-confirm-btn");
const dialogCloseBtn = document.getElementById("dialog-close-btn");

const audioFxBtn = document.getElementById("audio-fx-btn");
const audioFxModal = document.getElementById("audio-fx-modal");
const audioFxCloseBtn = document.getElementById("audio-fx-close-btn");
const fxYtNotice = document.getElementById("fx-yt-notice");
const eqPresetsEl = document.getElementById("eq-presets");
const eqBandSliders = Array.from(document.querySelectorAll("#eq-bands input[type='range']"));
const eqNormalizeToggle = document.getElementById("eq-normalize-toggle");
const crossfadePills = document.getElementById("crossfade-pills");

const ambientCoverLayer = document.getElementById("ambient-cover-layer");
const ambientCoverImg = document.getElementById("ambient-cover-img");
const coverHaloCanvas = document.getElementById("cover-halo-canvas");
const coverHaloCtx = coverHaloCanvas ? coverHaloCanvas.getContext("2d") : null;
const visIntensityPills = document.getElementById("vis-intensity-pills");
const visBackdropToggle = document.getElementById("vis-backdrop-toggle");
const visParticlesToggle = document.getElementById("vis-particles-toggle");
const visHaloToggle = document.getElementById("vis-halo-toggle");

const scriptToggleBtn = document.getElementById("script-toggle-btn");
const pasteLrcBtn = document.getElementById("paste-lrc-btn");
const lyricCardBtn = document.getElementById("lyric-card-btn");
const lyricCardBar = document.getElementById("lyric-card-bar");
const lyricCardCount = document.getElementById("lyric-card-count");
const generateCardBtn = document.getElementById("generate-card-btn");
const cancelCardBtn = document.getElementById("cancel-card-btn");

const lrcModal = document.getElementById("lrc-modal");
const lrcModalInput = document.getElementById("lrc-modal-input");
const lrcCloseBtn = document.getElementById("lrc-close-btn");
const lrcClearBtn = document.getElementById("lrc-clear-btn");
const lrcSaveBtn = document.getElementById("lrc-save-btn");

const cardModal = document.getElementById("card-modal");
const cardCloseBtn = document.getElementById("card-close-btn");
const cardPreviewImg = document.getElementById("card-preview-img");
const cardDownloadBtn = document.getElementById("card-download-btn");
const cardShareBtn = document.getElementById("card-share-btn");

// Queue DOM & Context Menu DOM
const tabQueue = document.getElementById("tab-queue");
const tabQueueCount = document.getElementById("tab-queue-count");
const queueSidebarPanel = document.getElementById("queue-sidebar-panel");
const sidebarQueueSub = document.getElementById("sidebar-queue-sub");
const sidebarQueueClearBtn = document.getElementById("sidebar-queue-clear-btn");
const sidebarQueueCurrent = document.getElementById("sidebar-queue-current");
const sidebarQueueUpNextBadge = document.getElementById("sidebar-queue-up-next-badge");
const sidebarQueueList = document.getElementById("sidebar-queue-list");

const headerQueueBtn = document.getElementById("header-queue-btn");
const headerQueueCount = document.getElementById("header-queue-count");
const queueToggleBtn = document.getElementById("queue-toggle-btn");
const queueBadge = document.getElementById("queue-badge");
const cinemaQueueBtn = document.getElementById("cinema-queue-btn");
const cinemaQueueCount = document.getElementById("cinema-queue-count");

const queueDrawer = document.getElementById("queue-drawer");
const queueBackdrop = document.getElementById("queue-drawer-backdrop");
const queueCloseBtn = document.getElementById("queue-close-btn");
const queueClearBtn = document.getElementById("queue-clear-btn");
const queueCountSub = document.getElementById("queue-count-sub");
const queueCurrentCard = document.getElementById("queue-current-card");
const queueUpNextBadge = document.getElementById("queue-up-next-badge");
const queueUpNextList = document.getElementById("queue-up-next-list");

const contextMenu = document.getElementById("context-menu");

// Mobile Navigation & Mini-Player DOM
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

// App State
let mobileView = "player";
let discoverTracks = [];
let queue = [];
let unshuffledQueue = null;
let currentIndex = -1;
let currentTrack = null;
let openPlaylistId = null;
let pendingTrackToAdd = null;
let isScrubbing = false;
let currentPalette = null;
let toastTimer = null;

// Playback Preferences
function loadPrefs() {
  const defaults = {
    volume: 0.85,
    eqPreset: "flat",
    eqBands: [0, 0, 0, 0, 0],
    normalize: true,
    crossfadeSec: 0,
    shuffle: false,
    repeatMode: "off",
    autoRadio: true,
    visualIntensity: "balanced",
    albumBackdrop: true,
    particlesEnabled: true,
    spectrumHalo: true,
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    if (parsed && typeof parsed === "object") {
      return { ...defaults, ...parsed };
    }
  } catch {}
  return defaults;
}

const prefs = loadPrefs();
let previousVolume = prefs.volume || 0.85;
volumeBar.value = String(prefs.volume);

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

// WebAudio Graph State
let audioCtx = null;
let analyser = null;
let freqData = null;
let masterGain = null;
let compressorNode = null;
let eqFilters = [];
const deckNodes = new Map();
let isCrossfading = false;
let crossfadeCleanupTimer = null;
let smoothBass = 0;
let smoothMid = 0;

// YouTube IFrame Fallback State
let ytPlayer = null;
let isUsingYTPlayer = false;

// Engines
const scene3D = new VibeScene3D(document.getElementById("bg-canvas"));
const lyricsEngine = new LyricsEngine(
  document.getElementById("lyrics-viewport"),
  document.getElementById("lyrics-container"),
  (seconds) => seekToSeconds(seconds),
  (selectedLines) => {
    const count = selectedLines.length;
    if (lyricCardCount) {
      lyricCardCount.textContent = count > 0 ? `${count}/4 selected` : "Select 1–4 lines";
    }
    if (generateCardBtn) {
      generateCardBtn.disabled = count === 0;
    }
  }
);

function getCurrentPlaybackTime() {
  if (isUsingYTPlayer && ytPlayer && typeof ytPlayer.getCurrentTime === "function") {
    return ytPlayer.getCurrentTime() || 0;
  }
  return Number.isFinite(activeDeck.currentTime) ? activeDeck.currentTime : 0;
}

function getEffectiveDuration() {
  if (isUsingYTPlayer && ytPlayer && typeof ytPlayer.getDuration === "function") {
    const ytDur = ytPlayer.getDuration();
    if (ytDur > 0) return ytDur;
  }
  if (Number.isFinite(activeDeck.duration) && activeDeck.duration > 0) {
    return activeDeck.duration;
  }
  return currentTrack?.duration || 0;
}

function seekToSeconds(seconds) {
  const target = Math.max(0, Number(seconds) || 0);
  if (isUsingYTPlayer && ytPlayer && typeof ytPlayer.seekTo === "function") {
    ytPlayer.seekTo(target, true);
  } else {
    activeDeck.currentTime = target;
  }
  updateMediaSessionPosition();
}

function setMobileView(view) {
  mobileView = view;
  appShell.setAttribute("data-mobile-view", view);

  mobileTabPlayer?.classList.toggle("active", view === "player");
  mobileTabLyrics?.classList.toggle("active", view === "lyrics");
  mobileTabDiscover?.classList.toggle("active", view === "discover");

  if (view === "player") {
    mobileMiniPlayer?.classList.add("hidden");
  } else if (currentTrack) {
    mobileMiniPlayer?.classList.remove("hidden");
  }

  if (view === "lyrics") {
    lyricsEngine.update(getCurrentPlaybackTime());
  }
}

// ================= SYNC OFFSET & CUSTOM LRC =================
function loadTrackOffset(videoId) {
  if (!videoId) return 0.0;
  try {
    const saved = localStorage.getItem("aura_sync_offset_" + videoId);
    if (saved !== null) {
      const val = parseFloat(saved);
      if (!isNaN(val)) return Math.round(val * 100) / 100;
    }
  } catch {}
  return 0.0;
}

function saveTrackOffset(videoId, offset) {
  if (!videoId) return;
  try {
    const val = Math.round(offset * 100) / 100;
    if (Math.abs(val) < 0.01) {
      localStorage.removeItem("aura_sync_offset_" + videoId);
    } else {
      localStorage.setItem("aura_sync_offset_" + videoId, String(val));
    }
  } catch {}
}

function loadCustomLrc(videoId) {
  if (!videoId) return null;
  try {
    return localStorage.getItem("aura_custom_lrc_" + videoId);
  } catch {
    return null;
  }
}

function saveCustomLrc(videoId, rawText) {
  if (!videoId) return;
  try {
    if (!rawText || !rawText.trim()) {
      localStorage.removeItem("aura_custom_lrc_" + videoId);
    } else {
      localStorage.setItem("aura_custom_lrc_" + videoId, rawText);
    }
  } catch {}
}

function updateSyncUI(offset) {
  if (!offsetVal) return;
  const val = Math.round(offset * 100) / 100;
  offsetVal.textContent = `${val >= 0 ? "+" : ""}${val.toFixed(2)}s`;
  offsetVal.classList.toggle("offset-active", Math.abs(val) > 0.01);
}

function applyOffsetDelta(delta) {
  const newOffset = lyricsEngine.setOffset(delta);
  updateSyncUI(newOffset);
  if (currentTrack?.videoId) {
    saveTrackOffset(currentTrack.videoId, newOffset);
    showToast(`Sync offset: ${newOffset >= 0 ? "+" : ""}${newOffset.toFixed(2)}s (saved)`);
  }
}

function resetOffset() {
  lyricsEngine.resetOffset();
  updateSyncUI(0.0);
  if (currentTrack?.videoId) {
    saveTrackOffset(currentTrack.videoId, 0.0);
    showToast("Sync offset reset to 0.00s");
  }
}

let lyricsScriptMode = (() => {
  try {
    const saved = localStorage.getItem(SCRIPT_MODE_KEY);
    return ["original", "roman", "dual"].includes(saved) ? saved : "original";
  } catch {
    return "original";
  }
})();

function saveScriptMode(mode) {
  lyricsScriptMode = mode;
  try {
    localStorage.setItem(SCRIPT_MODE_KEY, mode);
  } catch {}
}

function updateScriptToggleUI(scriptInfo, mode) {
  if (!scriptToggleBtn) return;
  if (!scriptInfo?.hasIndic) {
    scriptToggleBtn.classList.add("hidden");
    scriptToggleBtn.classList.remove("active");
    return;
  }
  scriptToggleBtn.classList.remove("hidden");
  const langLabel = scriptInfo.label || "Indic";
  if (mode === "roman") {
    scriptToggleBtn.textContent = "Hinglish ✓";
    scriptToggleBtn.classList.add("active");
    scriptToggleBtn.title = `${langLabel} transliterated to Hinglish — click for Dual-Script`;
  } else if (mode === "dual") {
    scriptToggleBtn.textContent = "Dual Script";
    scriptToggleBtn.classList.add("active");
    scriptToggleBtn.title = `Dual-Script (${langLabel} + Hinglish) — click for Original`;
  } else {
    scriptToggleBtn.textContent = "Hinglish";
    scriptToggleBtn.classList.remove("active");
    scriptToggleBtn.title = `${langLabel} detected — click to transliterate to Hinglish`;
  }
}

// ================= YOUTUBE IFRAME FALLBACK =================
function initYouTubePlayer() {
  if (ytPlayer || typeof YT === "undefined" || !YT.Player) return;
  try {
    ytPlayer = new YT.Player("yt-player-box", {
      height: "200",
      width: "200",
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        rel: 0,
        playsinline: 1,
        enablejsapi: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: () => {
          console.log("YouTube Player API Ready");
        },
        onStateChange: (event) => {
          if (!isUsingYTPlayer) return;
          if (event.data === YT.PlayerState.PLAYING) {
            setPlayingVisualState(true);
            if (syncBadge.textContent === "SYNCING..." || syncBadge.textContent === "STREAM ERROR") {
              syncBadge.textContent = "PLAYING";
            }
            onPlaybackStateChanged(true);
          } else if (event.data === YT.PlayerState.PAUSED) {
            setPlayingVisualState(false);
            onPlaybackStateChanged(false);
          } else if (event.data === YT.PlayerState.ENDED) {
            handleTrackEnded();
          }
        },
        onError: (err) => {
          console.warn("YT Embed error:", err);
          syncBadge.textContent = "PLAYBACK ERROR";
          showToast("Track unavailable. Skipping to next...");
          setTimeout(() => {
            advanceToNextTrack(true);
          }, 1500);
        },
      },
    });
  } catch (err) {
    console.warn("Error creating YT.Player:", err);
  }
}

window.onYouTubeIframeAPIReady = initYouTubePlayer;
if (typeof window !== "undefined" && window.YT && window.YT.Player) {
  initYouTubePlayer();
}

function stopHtml5Decks() {
  clearTimeout(crossfadeCleanupTimer);
  isCrossfading = false;
  [audioA, audioB].forEach((el) => {
    try {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch {}
  });
}

function playViaYouTubeEmbed(videoId) {
  isUsingYTPlayer = true;
  stopHtml5Decks();
  fxYtNotice?.classList.remove("hidden");

  const vol = Math.round(parseFloat(volumeBar.value) * 100);

  const tryPlay = (attempts = 0) => {
    if (!isUsingYTPlayer || currentTrack?.videoId !== videoId) return;
    if (ytPlayer && typeof ytPlayer.loadVideoById === "function") {
      try {
        if (typeof ytPlayer.setVolume === "function") ytPlayer.setVolume(vol);
        ytPlayer.loadVideoById(videoId);
        ytPlayer.playVideo();
        setPlayingVisualState(true);
        if (syncBadge.textContent === "STREAM ERROR" || syncBadge.textContent === "SYNCING...") {
          syncBadge.textContent = "PLAYING";
        }
        return;
      } catch (err) {
        console.warn("YT play exception:", err);
      }
    }

    if (attempts < 20) {
      if (!ytPlayer && window.YT && window.YT.Player) {
        initYouTubePlayer();
      }
      setTimeout(() => tryPlay(attempts + 1), 250);
    }
  };

  tryPlay();
}

function setPlayingVisualState(isPlaying) {
  playIcon.classList.toggle("hidden", isPlaying);
  pauseIcon.classList.toggle("hidden", !isPlaying);
  miniPlayIcon?.classList.toggle("hidden", isPlaying);
  miniPauseIcon?.classList.toggle("hidden", !isPlaying);
  artContainer.classList.toggle("playing", isPlaying);
  updateMediaSessionState(isPlaying);
  renderQueue();
}

// ================= GLASSMORPHIC DIALOG MODAL =================
let activeDialogResolve = null;

function openDialog({ title, message = "", mode = "confirm", placeholder = "", defaultValue = "", confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    activeDialogResolve = resolve;
    dialogTitle.textContent = title;
    dialogMessage.textContent = message;
    dialogMessage.classList.toggle("hidden", !message);

    if (mode === "prompt") {
      dialogInput.classList.remove("hidden");
      dialogInput.placeholder = placeholder;
      dialogInput.value = defaultValue;
    } else {
      dialogInput.classList.add("hidden");
      dialogInput.value = "";
    }

    dialogConfirmBtn.textContent = confirmLabel;
    dialogConfirmBtn.className = `dialog-btn ${danger ? "danger" : "primary"}`;
    dialogModal.classList.remove("hidden");
    if (mode === "prompt") {
      setTimeout(() => dialogInput.focus(), 20);
    }
  });
}

function closeDialog(result) {
  dialogModal.classList.add("hidden");
  const resolve = activeDialogResolve;
  activeDialogResolve = null;
  if (resolve) resolve(result);
}

dialogCancelBtn?.addEventListener("click", () => closeDialog(null));
dialogCloseBtn?.addEventListener("click", () => closeDialog(null));
dialogModal?.addEventListener("click", (e) => {
  if (e.target === dialogModal) closeDialog(null);
});
dialogConfirmBtn?.addEventListener("click", () => {
  const val = dialogInput.classList.contains("hidden") ? true : dialogInput.value;
  closeDialog(val);
});
dialogInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    closeDialog(dialogInput.value);
  }
});

// ================= PLAYLIST STORAGE & BACKUP =================
function loadPlaylists() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (Array.isArray(raw) && raw.length) return raw;
  } catch {}
  return [{ id: "favorites", name: "Favorites", tracks: [] }];
}

let playlists = loadPlaylists();

function savePlaylists() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(playlists));
}

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "null");
    if (raw && typeof raw === "object" && raw.plays) return raw;
  } catch {}
  return { plays: [], artistCounts: {} };
}

let listenHistory = loadHistory();

function saveHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(listenHistory));
}

function recordPlay(track) {
  if (!track || !track.videoId) return;
  listenHistory.plays = listenHistory.plays.filter((p) => p.videoId !== track.videoId);
  listenHistory.plays.unshift({
    videoId: track.videoId,
    title: track.title,
    artist: track.artist,
    timestamp: Date.now(),
  });
  if (listenHistory.plays.length > 50) listenHistory.plays.length = 50;

  const artist = track.artist || "";
  if (artist) {
    const primary = artist.split(/[,&]|\bfeat\.?\b|\bft\.?\b/i)[0].trim();
    if (primary) {
      listenHistory.artistCounts[primary] = (listenHistory.artistCounts[primary] || 0) + 1;
    }
  }
  saveHistory();
}

function getTopArtists(n = 5) {
  const entries = Object.entries(listenHistory.artistCounts || {});
  entries.sort((a, b) => b[1] - a[1]);
  return entries.slice(0, n).map(([name]) => name);
}

function getRecentVideoIds(n = 5) {
  return (listenHistory.plays || []).slice(0, n).map((p) => p.videoId);
}

function hasListeningHistory() {
  return (listenHistory.plays || []).length >= 2;
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

function exportLibraryBackup() {
  const syncOffsets = {};
  const customLyrics = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith("aura_sync_offset_")) {
      syncOffsets[k.slice("aura_sync_offset_".length)] = localStorage.getItem(k);
    } else if (k?.startsWith("aura_custom_lrc_")) {
      customLyrics[k.slice("aura_custom_lrc_".length)] = localStorage.getItem(k);
    }
  }

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    playlists,
    listenHistory,
    prefs,
    syncOffsets,
    customLyrics,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aura-music-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Library backup exported");
}

function importLibraryBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result || "{}"));
      if (!Array.isArray(data.playlists)) {
        throw new Error("Invalid backup file");
      }
      const hasFav = data.playlists.some((p) => p && p.id === "favorites");
      playlists = hasFav ? data.playlists : [{ id: "favorites", name: "Favorites", tracks: [] }, ...data.playlists];
      savePlaylists();

      if (data.listenHistory && Array.isArray(data.listenHistory.plays)) {
        listenHistory = data.listenHistory;
        saveHistory();
      }
      if (data.syncOffsets && typeof data.syncOffsets === "object") {
        Object.entries(data.syncOffsets).forEach(([vid, val]) => {
          localStorage.setItem("aura_sync_offset_" + vid, String(val));
        });
      }
      if (data.customLyrics && typeof data.customLyrics === "object") {
        Object.entries(data.customLyrics).forEach(([vid, val]) => {
          localStorage.setItem("aura_custom_lrc_" + vid, String(val));
        });
      }
      renderPlaylistsHome();
      updateFavoriteButton();
      showToast(`Restored ${playlists.length} playlists`);
    } catch {
      showToast("Could not read backup JSON");
    }
  };
  reader.readAsText(file);
}

exportLibraryBtn?.addEventListener("click", exportLibraryBackup);
importLibraryBtn?.addEventListener("click", () => importLibraryFile?.click());
importLibraryFile?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) importLibraryBackup(file);
  e.target.value = "";
});

// ================= PLAY QUEUE, SHUFFLE, REPEAT & AUTO-RADIO =================
let playNextCount = 0;
let isTransitioningTrack = false;
let isFetchingRadio = false;
let activeContextTrack = null;
let activeContextOptions = null;

function updateTransportModeUI() {
  shuffleBtn?.classList.toggle("active", prefs.shuffle);
  shuffleBtn?.setAttribute("aria-pressed", String(prefs.shuffle));

  repeatBtn?.classList.toggle("active", prefs.repeatMode !== "off");
  repeatOneBadge?.classList.toggle("hidden", prefs.repeatMode !== "one");
  if (repeatBtn) {
    const labelMap = { off: "Repeat: Off (R)", all: "Repeat: Queue (R)", one: "Repeat: Track (R)" };
    repeatBtn.title = labelMap[prefs.repeatMode] || labelMap.off;
  }

  autoRadioBtn?.classList.toggle("active", prefs.autoRadio);
  autoRadioBtn?.setAttribute("aria-pressed", String(prefs.autoRadio));
}

function toggleShuffle() {
  prefs.shuffle = !prefs.shuffle;
  if (prefs.shuffle) {
    unshuffledQueue = [...queue];
    const shuffled = buildShuffledQueue(queue, currentIndex);
    queue = shuffled.queue;
    currentIndex = shuffled.currentIndex;
    showToast("Shuffle enabled");
  } else {
    if (Array.isArray(unshuffledQueue) && unshuffledQueue.length) {
      const currentVid = currentTrack?.videoId;
      queue = [...unshuffledQueue];
      if (currentVid) {
        const restoredIdx = queue.findIndex((t) => t.videoId === currentVid);
        if (restoredIdx >= 0) currentIndex = restoredIdx;
      }
    }
    unshuffledQueue = null;
    showToast("Shuffle disabled");
  }
  savePrefs();
  saveQueueState();
  updateTransportModeUI();
  renderQueue();
}

function cycleRepeatMode() {
  const order = ["off", "all", "one"];
  const nextIdx = (order.indexOf(prefs.repeatMode) + 1) % order.length;
  prefs.repeatMode = order[nextIdx];
  savePrefs();
  updateTransportModeUI();
  const labels = { off: "Repeat Off", all: "Repeat Queue", one: "Repeat Current Track" };
  showToast(labels[prefs.repeatMode]);
}

function toggleAutoRadio() {
  prefs.autoRadio = !prefs.autoRadio;
  savePrefs();
  updateTransportModeUI();
  showToast(prefs.autoRadio ? "Endless Radio enabled" : "Endless Radio disabled");
}

function saveQueueState() {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    localStorage.setItem(QUEUE_IDX_KEY, String(currentIndex));
  } catch {}
}

function loadQueueState() {
  try {
    const rawQueue = JSON.parse(localStorage.getItem(QUEUE_KEY) || "null");
    const rawIdx = parseInt(localStorage.getItem(QUEUE_IDX_KEY) || "-1", 10);
    if (Array.isArray(rawQueue) && rawQueue.length > 0) {
      queue = rawQueue;
      currentIndex = rawIdx >= 0 && rawIdx < rawQueue.length ? rawIdx : 0;
      currentTrack = queue[currentIndex] || null;
      if (currentTrack) {
        updateTrackDisplay(currentTrack);
        updateFavoriteButton();
      }
      return true;
    }
  } catch {}
  return false;
}

function attachThumbFallback(imgEl, videoId) {
  if (!imgEl || !videoId) return;
  const fallback = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  imgEl.addEventListener("error", () => {
    if (imgEl.src !== fallback) imgEl.src = fallback;
  }, { once: true });
}

function updateTrackDisplay(track) {
  if (!track) return;
  trackTitleEl.textContent = track.title;
  trackArtistEl.textContent = track.artist;
  attachThumbFallback(albumArt, track.videoId);
  albumArt.src = track.thumbnail;
  albumArt.classList.remove("hidden");
  artPlaceholder.classList.add("hidden");
  document.body.setAttribute("data-has-track", "true");
  if (ambientCoverImg) {
    ambientCoverImg.classList.remove("loaded");
    const fallback = `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`;
    ambientCoverImg.onload = () => ambientCoverImg.classList.add("loaded");
    ambientCoverImg.onerror = () => {
      if (ambientCoverImg.src !== fallback) ambientCoverImg.src = fallback;
    };
    ambientCoverImg.src = track.thumbnail || fallback;
    ambientCoverLayer?.classList.toggle("visible", Boolean(prefs.albumBackdrop));
  }
  if (miniTitle) miniTitle.textContent = track.title;
  if (miniArtist) miniArtist.textContent = track.artist;
  if (miniAlbumArt) {
    attachThumbFallback(miniAlbumArt, track.videoId);
    miniAlbumArt.src = track.thumbnail;
  }
}

function getNextTrackIndex() {
  if (prefs.repeatMode === "one" && currentIndex >= 0) return currentIndex;
  if (currentIndex + 1 < queue.length) return currentIndex + 1;
  if (prefs.repeatMode === "all" && queue.length > 0) return 0;
  return null;
}

async function fetchAutoRadioNext() {
  if (isFetchingRadio || !currentTrack) return false;
  isFetchingRadio = true;
  try {
    syncBadge.textContent = "RADIO...";
    const res = await fetch("/api/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seedVideoIds: [currentTrack.videoId, ...getRecentVideoIds(4)].slice(0, 5),
        topArtists: getTopArtists(5),
        excludeIds: queue.map((t) => t.videoId),
      }),
    });
    const data = await res.json();
    const fresh = (data.results || []).filter(
      (t) => t?.videoId && !queue.some((q) => q.videoId === t.videoId)
    );
    if (fresh.length) {
      queue.push(...fresh.slice(0, 10));
      saveQueueState();
      renderQueue();
      showToast(`Radio queued ${Math.min(10, fresh.length)} similar tracks`);
      return true;
    }
  } catch (err) {
    console.warn("Auto-radio fetch failed:", err);
  } finally {
    isFetchingRadio = false;
  }
  return false;
}

async function advanceToNextTrack(fromError = false) {
  const nextIdx = getNextTrackIndex();
  if (nextIdx !== null) {
    if (nextIdx === currentIndex && !fromError) {
      seekToSeconds(0);
      if (isUsingYTPlayer && ytPlayer?.playVideo) ytPlayer.playVideo();
      else activeDeck.play().catch(() => {});
      return;
    }
    if (nextIdx !== currentIndex) {
      playTrack(nextIdx);
      return;
    }
  }

  if (!fromError && prefs.autoRadio && currentTrack) {
    const added = await fetchAutoRadioNext();
    if (added && currentIndex + 1 < queue.length) {
      playTrack(currentIndex + 1);
      return;
    }
  }

  setPlayingVisualState(false);
  syncBadge.textContent = "IDLE";
}

function handleTrackEnded() {
  if (isTransitioningTrack || isCrossfading) return;
  isTransitioningTrack = true;
  setTimeout(() => { isTransitioningTrack = false; }, 800);

  onPlaybackStateChanged(false);
  advanceToNextTrack(false);
}

function addToQueue(track) {
  if (!track || !track.videoId) return;
  queue.push({ ...track });
  saveQueueState();
  renderQueue();
  updateQueueBadges();
  showToast("Added to queue");
}

function addTracksToQueue(tracks) {
  const valid = (tracks || []).filter((t) => t && t.videoId);
  if (!valid.length) return;
  valid.forEach((t) => queue.push({ ...t }));
  saveQueueState();
  renderQueue();
  updateQueueBadges();
  showToast(`Added ${valid.length} ${valid.length === 1 ? "track" : "tracks"} to queue`);
}

function playNext(track) {
  if (!track || !track.videoId) return;
  if (currentIndex < 0 || queue.length === 0) {
    queue.splice(playNextCount, 0, { ...track });
  } else {
    queue.splice(currentIndex + 1 + playNextCount, 0, { ...track });
  }
  playNextCount++;
  saveQueueState();
  renderQueue();
  updateQueueBadges();
  showToast("Will play next");
}

function removeFromQueue(uIdx) {
  const actualIdx = currentIndex + 1 + uIdx;
  if (actualIdx >= 0 && actualIdx < queue.length) {
    queue.splice(actualIdx, 1);
    if (playNextCount > 0 && uIdx < playNextCount) {
      playNextCount = Math.max(0, playNextCount - 1);
    }
    saveQueueState();
    renderQueue();
    updateQueueBadges();
    showToast("Removed from queue");
  }
}

function clearQueue() {
  if (currentIndex >= 0 && currentIndex < queue.length) {
    queue = [queue[currentIndex]];
    currentIndex = 0;
  } else {
    queue = [];
    currentIndex = -1;
  }
  playNextCount = 0;
  unshuffledQueue = null;
  saveQueueState();
  renderQueue();
  updateQueueBadges();
  showToast("Queue cleared");
}

function reorderQueue(fromIdx, toIdx) {
  const actualFrom = currentIndex + 1 + fromIdx;
  const actualTo = currentIndex + 1 + toIdx;
  if (actualFrom >= 0 && actualFrom < queue.length && actualTo >= 0 && actualTo < queue.length) {
    const [moved] = queue.splice(actualFrom, 1);
    queue.splice(actualTo, 0, moved);
    saveQueueState();
    renderQueue();
    updateQueueBadges();
  }
}

function updateQueueBadges() {
  const upcomingCount = Math.max(0, queue.length - (currentIndex + 1));
  const subText = `${upcomingCount} ${upcomingCount === 1 ? "track" : "tracks"} upcoming`;

  if (queueCountSub) queueCountSub.textContent = subText;
  if (sidebarQueueSub) sidebarQueueSub.textContent = subText;
  if (queueUpNextBadge) queueUpNextBadge.textContent = `${upcomingCount} ${upcomingCount === 1 ? "track" : "tracks"}`;
  if (sidebarQueueUpNextBadge) sidebarQueueUpNextBadge.textContent = `${upcomingCount} ${upcomingCount === 1 ? "track" : "tracks"}`;

  if (queueBadge) {
    queueBadge.textContent = String(upcomingCount);
    queueBadge.classList.toggle("hidden", upcomingCount === 0);
  }
  if (headerQueueCount) headerQueueCount.textContent = String(upcomingCount);
  if (cinemaQueueCount) cinemaQueueCount.textContent = String(upcomingCount);
  if (tabQueueCount) tabQueueCount.textContent = String(upcomingCount);
}

function renderQueue() {
  const upcomingTracks = queue.slice(currentIndex + 1);
  const upcomingCount = upcomingTracks.length;
  updateQueueBadges();

  const renderCurrentCard = (targetEl) => {
    if (!targetEl) return;
    targetEl.innerHTML = "";
    targetEl.classList.toggle("playing", Boolean(currentTrack && artContainer.classList.contains("playing")));
    if (!currentTrack) {
      targetEl.innerHTML = `<div class="queue-empty-now">No track currently playing</div>`;
      return;
    }
    targetEl.innerHTML = `
      <div class="queue-current-thumb-wrap">
        <img src="${escapeHtml(currentTrack.thumbnail)}" referrerpolicy="no-referrer" alt="" />
        <div class="queue-current-eq"><span></span><span></span><span></span></div>
      </div>
      <div class="queue-current-info">
        <div class="queue-current-title">${escapeHtml(currentTrack.title)}</div>
        <div class="queue-current-artist">${escapeHtml(currentTrack.artist)}</div>
      </div>
      <span class="queue-current-dur">${escapeHtml(currentTrack.durationText || formatTime(currentTrack.duration))}</span>
    `;
    attachThumbFallback(targetEl.querySelector("img"), currentTrack.videoId);
  };

  renderCurrentCard(queueCurrentCard);
  renderCurrentCard(sidebarQueueCurrent);

  const renderUpcomingList = (containerEl) => {
    if (!containerEl) return;
    containerEl.innerHTML = "";

    if (upcomingCount === 0) {
      containerEl.innerHTML = `
        <div class="queue-empty-state">
          <svg viewBox="0 0 24 24" class="icon"><path fill="currentColor" d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>
          <p>Your queue is empty</p>
          <span>Use "Play Next" or "Add to Queue" on any song to queue it up.</span>
        </div>
      `;
      return;
    }

    upcomingTracks.forEach((t, uIdx) => {
      const item = document.createElement("div");
      item.className = "queue-item";
      item.setAttribute("draggable", "true");
      item.dataset.index = String(uIdx);

      item.innerHTML = `
        <div class="queue-drag-handle" title="Drag to reorder">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 18c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0-6c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0-6c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6 12c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0-6c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0-6c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>
        </div>
        <span class="queue-item-num">${uIdx + 1}</span>
        <img class="queue-item-thumb" src="${escapeHtml(t.thumbnail)}" referrerpolicy="no-referrer" alt="" />
        <div class="queue-item-info">
          <div class="queue-item-title">${escapeHtml(t.title)}</div>
          <div class="queue-item-artist">${escapeHtml(t.artist)}</div>
        </div>
        <span class="queue-item-dur">${escapeHtml(t.durationText || formatTime(t.duration))}</span>
        <div class="queue-move-btns">
          <button class="queue-move-btn queue-move-up" title="Move up" aria-label="Move up" ${uIdx === 0 ? "disabled" : ""}>&#9650;</button>
          <button class="queue-move-btn queue-move-down" title="Move down" aria-label="Move down" ${uIdx === upcomingCount - 1 ? "disabled" : ""}>&#9660;</button>
        </div>
        <button class="queue-item-remove" title="Remove from queue" aria-label="Remove from queue">&times;</button>
      `;

      attachThumbFallback(item.querySelector(".queue-item-thumb"), t.videoId);

      item.addEventListener("click", (e) => {
        if (e.target.closest(".queue-item-remove") || e.target.closest(".queue-drag-handle") || e.target.closest(".queue-move-btn")) return;
        playTrack(currentIndex + 1 + uIdx);
      });

      item.querySelector(".queue-move-up")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (uIdx > 0) reorderQueue(uIdx, uIdx - 1);
      });

      item.querySelector(".queue-move-down")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (uIdx < upcomingCount - 1) reorderQueue(uIdx, uIdx + 1);
      });

      item.querySelector(".queue-item-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        removeFromQueue(uIdx);
      });

      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, t, { queueIndex: uIdx });
      });

      item.addEventListener("dragstart", (e) => {
        item.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(uIdx));
      });
      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        item.classList.add("drag-over");
      });
      item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        item.classList.remove("drag-over");
        const fromIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
        if (!isNaN(fromIdx) && fromIdx !== uIdx) reorderQueue(fromIdx, uIdx);
      });
      item.addEventListener("dragend", () => {
        item.classList.remove("dragging");
        containerEl.querySelectorAll(".queue-item").forEach((el) => el.classList.remove("drag-over"));
      });

      containerEl.appendChild(item);
    });
  };

  renderUpcomingList(queueUpNextList);
  renderUpcomingList(sidebarQueueList);
}

function toggleQueueDrawer(show) {
  if (!queueDrawer) return;
  const isCurrentlyOpen = !queueDrawer.classList.contains("hidden");
  const targetOpen = typeof show === "boolean" ? show : !isCurrentlyOpen;

  if (targetOpen) {
    renderQueue();
    queueDrawer.classList.remove("hidden");
    queueBackdrop?.classList.remove("hidden");
    queueToggleBtn?.classList.add("active");
    if (isCinemaMode) resetCinemaInactivity();
  } else {
    queueDrawer.classList.add("hidden");
    queueBackdrop?.classList.add("hidden");
    queueToggleBtn?.classList.remove("active");
  }
}

function openContextMenu(x, y, track, options = {}) {
  if (!contextMenu || !track) return;
  activeContextTrack = track;
  activeContextOptions = options;

  const removeBtn = contextMenu.querySelector('[data-action="remove-item"]');
  const removeText = document.getElementById("context-remove-text");

  if (options.removable && options.playlistId) {
    removeBtn?.classList.remove("hidden");
    if (removeText) removeText.textContent = "Remove from Playlist";
  } else if (options.queueIndex !== undefined) {
    removeBtn?.classList.remove("hidden");
    if (removeText) removeText.textContent = "Remove from Queue";
  } else {
    removeBtn?.classList.add("hidden");
  }

  contextMenu.classList.remove("hidden");
  const menuWidth = contextMenu.offsetWidth || 195;
  const menuHeight = contextMenu.offsetHeight || 190;
  contextMenu.style.left = `${Math.max(10, Math.min(x, window.innerWidth - menuWidth - 12))}px`;
  contextMenu.style.top = `${Math.max(10, Math.min(y, window.innerHeight - menuHeight - 12))}px`;
}

function closeContextMenu() {
  if (!contextMenu) return;
  contextMenu.classList.add("hidden");
  activeContextTrack = null;
  activeContextOptions = null;
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

// ================= WEB AUDIO: 5-BAND EQ, COMPRESSOR & CROSSFADE =================
function applyAudioFxSettings() {
  eqFilters.forEach((filter, idx) => {
    filter.gain.value = Number(prefs.eqBands?.[idx] ?? 0);
  });

  if (compressorNode) {
    if (prefs.normalize) {
      compressorNode.threshold.value = -18;
      compressorNode.knee.value = 18;
      compressorNode.ratio.value = 4;
      compressorNode.attack.value = 0.004;
      compressorNode.release.value = 0.25;
    } else {
      compressorNode.threshold.value = 0;
      compressorNode.ratio.value = 1;
    }
  }

  if (masterGain) {
    masterGain.gain.value = parseFloat(volumeBar.value);
  }
}

function syncAudioFxUI() {
  eqBandSliders.forEach((slider, idx) => {
    const val = Number(prefs.eqBands?.[idx] ?? 0);
    slider.value = String(val);
    const label = document.getElementById(`eq-val-${idx}`);
    if (label) label.textContent = `${val > 0 ? "+" : ""}${val} dB`;
  });

  eqPresetsEl?.querySelectorAll(".eq-preset-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.preset === prefs.eqPreset);
  });

  if (eqNormalizeToggle) eqNormalizeToggle.checked = Boolean(prefs.normalize);
  crossfadePills?.querySelectorAll(".cf-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.cf) === Number(prefs.crossfadeSec || 0));
  });
  visIntensityPills?.querySelectorAll(".vis-int-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.intensity === (prefs.visualIntensity || "balanced"));
  });
  if (visBackdropToggle) visBackdropToggle.checked = prefs.albumBackdrop !== false;
  if (visParticlesToggle) visParticlesToggle.checked = prefs.particlesEnabled !== false;
  if (visHaloToggle) visHaloToggle.checked = prefs.spectrumHalo !== false;
  fxYtNotice?.classList.toggle("hidden", !isUsingYTPlayer);
}

function applyVisualPreferences() {
  const intensity = ["minimal", "balanced", "vivid"].includes(prefs.visualIntensity)
    ? prefs.visualIntensity
    : "balanced";
  const particlesEnabled = prefs.particlesEnabled !== false;
  const albumBackdrop = prefs.albumBackdrop !== false;
  const spectrumHalo = prefs.spectrumHalo !== false;

  document.body.setAttribute("data-visual-intensity", intensity);
  scene3D.setVisualOptions({ intensity, particlesEnabled });

  if (ambientCoverLayer) {
    ambientCoverLayer.classList.toggle("hidden", !albumBackdrop);
    ambientCoverLayer.classList.toggle("visible", albumBackdrop && Boolean(currentTrack));
  }
  if (coverHaloCanvas) {
    coverHaloCanvas.classList.toggle("hidden", !spectrumHalo);
  }
}

function initWebAudio() {
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return;
  }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();

    eqFilters = EQ_FREQUENCIES.map((freq, idx) => {
      const f = audioCtx.createBiquadFilter();
      f.type = idx === 0 ? "lowshelf" : idx === EQ_FREQUENCIES.length - 1 ? "highshelf" : "peaking";
      f.frequency.value = freq;
      f.Q.value = 1.0;
      return f;
    });

    compressorNode = audioCtx.createDynamicsCompressor();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    masterGain = audioCtx.createGain();

    for (let i = 0; i < eqFilters.length - 1; i++) {
      eqFilters[i].connect(eqFilters[i + 1]);
    }
    eqFilters[eqFilters.length - 1].connect(compressorNode);
    compressorNode.connect(analyser);
    analyser.connect(masterGain);
    masterGain.connect(audioCtx.destination);

    [audioA, audioB].forEach((el) => {
      const source = audioCtx.createMediaElementSource(el);
      const deckGain = audioCtx.createGain();
      deckGain.gain.value = el === activeDeck ? 1.0 : 0.0;
      el.volume = 1.0;
      source.connect(deckGain);
      deckGain.connect(eqFilters[0]);
      deckNodes.set(el, { source, deckGain });
    });

    freqData = new Uint8Array(analyser.frequencyBinCount);
    applyAudioFxSettings();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  } catch (err) {
    console.warn("WebAudio init fallback:", err);
  }
}

function resetDeckGains() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const activeNode = deckNodes.get(activeDeck);
  const inactiveNode = deckNodes.get(inactiveDeck);
  if (activeNode) {
    activeNode.deckGain.gain.cancelScheduledValues(now);
    activeNode.deckGain.gain.setValueAtTime(1.0, now);
  }
  if (inactiveNode) {
    inactiveNode.deckGain.gain.cancelScheduledValues(now);
    inactiveNode.deckGain.gain.setValueAtTime(0.0, now);
  }
}

audioFxBtn?.addEventListener("click", () => {
  syncAudioFxUI();
  audioFxModal?.classList.remove("hidden");
});
audioFxCloseBtn?.addEventListener("click", () => audioFxModal?.classList.add("hidden"));
audioFxModal?.addEventListener("click", (e) => {
  if (e.target === audioFxModal) audioFxModal.classList.add("hidden");
});

eqPresetsEl?.addEventListener("click", (e) => {
  const btn = e.target.closest(".eq-preset-btn");
  if (!btn) return;
  const preset = btn.dataset.preset;
  if (!EQ_PRESETS[preset]) return;
  prefs.eqPreset = preset;
  prefs.eqBands = [...EQ_PRESETS[preset]];
  savePrefs();
  applyAudioFxSettings();
  syncAudioFxUI();
});

eqBandSliders.forEach((slider) => {
  slider.addEventListener("input", () => {
    const idx = parseInt(slider.dataset.band, 10);
    prefs.eqBands[idx] = parseFloat(slider.value);
    prefs.eqPreset = "custom";
    savePrefs();
    applyAudioFxSettings();
    syncAudioFxUI();
  });
});

eqNormalizeToggle?.addEventListener("change", () => {
  prefs.normalize = Boolean(eqNormalizeToggle.checked);
  savePrefs();
  applyAudioFxSettings();
});

crossfadePills?.addEventListener("click", (e) => {
  const btn = e.target.closest(".cf-btn");
  if (!btn) return;
  prefs.crossfadeSec = parseInt(btn.dataset.cf, 10) || 0;
  savePrefs();
  syncAudioFxUI();
});

visIntensityPills?.addEventListener("click", (e) => {
  const btn = e.target.closest(".vis-int-btn");
  if (!btn) return;
  prefs.visualIntensity = btn.dataset.intensity || "balanced";
  savePrefs();
  applyVisualPreferences();
  syncAudioFxUI();
});

visBackdropToggle?.addEventListener("change", () => {
  prefs.albumBackdrop = Boolean(visBackdropToggle.checked);
  savePrefs();
  applyVisualPreferences();
});

visParticlesToggle?.addEventListener("change", () => {
  prefs.particlesEnabled = Boolean(visParticlesToggle.checked);
  savePrefs();
  applyVisualPreferences();
});

visHaloToggle?.addEventListener("change", () => {
  prefs.spectrumHalo = Boolean(visHaloToggle.checked);
  savePrefs();
  applyVisualPreferences();
});

// ================= MEDIA SESSION API =================
let lastMediaPosUpdate = 0;

function initMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const handlers = {
    play: () => playBtn.click(),
    pause: () => playBtn.click(),
    previoustrack: () => prevBtn.click(),
    nexttrack: () => nextBtn.click(),
    seekbackward: (details) => seekToSeconds(Math.max(0, getCurrentPlaybackTime() - (details?.seekOffset || 10))),
    seekforward: (details) => seekToSeconds(getCurrentPlaybackTime() + (details?.seekOffset || 10)),
    seekto: (details) => {
      if (details?.seekTime !== undefined) seekToSeconds(details.seekTime);
    },
  };
  Object.entries(handlers).forEach(([action, fn]) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {}
  });
}

function updateMediaSessionMetadata(track) {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined" || !track) return;
  const thumb = track.thumbnail || `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || "AURA Music",
      artist: track.artist || "YouTube Music",
      album: track.album || "AURA Spatial",
      artwork: [
        { src: thumb, sizes: "512x512", type: "image/jpeg" },
      ],
    });
  } catch {}
}

function updateMediaSessionState(isPlaying) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  } catch {}
}

function updateMediaSessionPosition(force = false) {
  if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function") return;
  const now = performance.now();
  if (!force && now - lastMediaPosUpdate < 1000) return;
  const dur = getEffectiveDuration();
  const pos = getCurrentPlaybackTime();
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(pos) || pos < 0) return;
  lastMediaPosUpdate = now;
  try {
    navigator.mediaSession.setPositionState({
      duration: dur,
      playbackRate: 1.0,
      position: Math.min(pos, dur),
    });
  } catch {}
}

// ================= ALBUM ART 3D TILT & VIBES =================
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
    <img src="${escapeHtml(track.thumbnail)}" referrerpolicy="no-referrer" alt="" loading="lazy" />
    <div class="track-item-info">
      <div class="track-item-title">${escapeHtml(track.title)}</div>
      <div class="track-item-artist">${escapeHtml(track.artist)}</div>
    </div>
    <span class="track-item-dur">${escapeHtml(track.durationText || formatTime(track.duration))}</span>
    <div class="track-actions-wrap">
      <button class="track-action-btn" title="${actionTitle}">${actionSymbol}</button>
      <button class="track-menu-btn" title="More options" aria-label="More options">
        <svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
      </button>
    </div>
  `;

  attachThumbFallback(row.querySelector("img"), track.videoId);

  row.addEventListener("click", () => {
    if (options.queueOnlyClicked) {
      unshuffledQueue = null;
      queue = [{ ...track }];
      playTrack(0);
      return;
    }
    playTrackList(sourceList, idx);
  });

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, track, { ...options, sourceList, index: idx });
  });

  row.querySelector(".track-action-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (options.removable && options.playlistId) {
      removeTrackFromPlaylist(options.playlistId, track.videoId);
    } else {
      openAddModal(track);
    }
  });

  row.querySelector(".track-menu-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openContextMenu(rect.left - 130, rect.bottom + 6, track, { ...options, sourceList, index: idx });
  });

  return row;
}

function playTrackList(tracks, startIdx = 0) {
  if (!Array.isArray(tracks) || !tracks.length) return;
  unshuffledQueue = null;
  if (prefs.shuffle) {
    const picked = tracks[startIdx] || tracks[0];
    const rest = tracks.filter((_, i) => i !== startIdx);
    const shuffled = buildShuffledQueue([picked, ...rest], 0);
    queue = shuffled.queue;
    playTrack(0);
  } else {
    queue = [...tracks];
    playTrack(startIdx);
  }
}

function renderDiscoverList(tracks, rowOptions = {}) {
  discoverTracks = tracks;
  trackListEl.innerHTML = "";
  if (!tracks.length) {
    trackListEl.innerHTML = `<div class="skeleton-loader">No tracks found. Try another search.</div>`;
    return;
  }
  tracks.forEach((t, idx) => {
    trackListEl.appendChild(createTrackRow(t, idx, discoverTracks, rowOptions));
  });
}

async function loadTrackMetadata(track) {
  const customRaw = loadCustomLrc(track.videoId);
  if (!customRaw) updateScriptToggleUI(null, "original");
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

    if (customRaw) {
      const parsedCustom = parseClientLrc(customRaw, track.duration || 240);
      const scriptInfo = lyricsEngine.load(parsedCustom, lyricsScriptMode);
      updateScriptToggleUI(scriptInfo, lyricsEngine.scriptMode);
      syncBadge.textContent = parsedCustom.synced ? "CUSTOM LRC" : "CUSTOM";
    } else {
      const scriptInfo = lyricsEngine.load(meta.lyrics, lyricsScriptMode);
      updateScriptToggleUI(scriptInfo, lyricsEngine.scriptMode);
      if (meta.lyrics.word_native) syncBadge.textContent = "WORD SYNC";
      else if (meta.lyrics.synced) syncBadge.textContent = "LRC SYNC";
      else if (meta.lyrics.lines?.length) syncBadge.textContent = "PLAIN";
      else syncBadge.textContent = "AUDIO ONLY";
    }
  } catch (err) {
    console.error("Metadata error:", err);
    if (customRaw && currentTrack?.videoId === track.videoId) {
      const parsedCustom = parseClientLrc(customRaw, track.duration || 240);
      const scriptInfo = lyricsEngine.load(parsedCustom, lyricsScriptMode);
      updateScriptToggleUI(scriptInfo, lyricsEngine.scriptMode);
      syncBadge.textContent = parsedCustom.synced ? "CUSTOM LRC" : "CUSTOM";
    } else {
      updateScriptToggleUI(null, "original");
      syncBadge.textContent = "AUDIO ONLY";
    }
  }
}

async function playTrack(idx) {
  if (idx < 0 || idx >= queue.length) return;
  currentIndex = idx;
  const track = queue[idx];
  currentTrack = track;

  playNextCount = 0;
  clearTimeout(crossfadeCleanupTimer);
  isCrossfading = false;

  saveQueueState();
  renderQueue();
  updateQueueBadges();

  isUsingYTPlayer = false;
  fxYtNotice?.classList.add("hidden");
  if (ytPlayer && ytPlayer.stopVideo) {
    try { ytPlayer.stopVideo(); } catch {}
  }

  initWebAudio();
  resetDeckGains();
  try {
    inactiveDeck.pause();
    inactiveDeck.removeAttribute("src");
    inactiveDeck.load();
  } catch {}

  const savedOffset = loadTrackOffset(track.videoId);
  lyricsEngine.offset = savedOffset;
  updateSyncUI(savedOffset);
  highlightPlayingRows();
  updateFavoriteButton();
  updateTrackDisplay(track);
  updateMediaSessionMetadata(track);

  userExitedCinemaManually = false;
  onPlaybackStateChanged(false);
  recordPlay(track);

  if (window.innerWidth <= 960 && mobileView === "discover") {
    setMobileView("player");
  } else if (mobileView !== "player") {
    mobileMiniPlayer?.classList.remove("hidden");
  }

  syncBadge.textContent = "SYNCING...";

  const canDirectStream = isLocalOrLanHostname(window.location.hostname);
  if (!canDirectStream) {
    playViaYouTubeEmbed(track.videoId);
  } else {
    activeDeck.src = `/api/stream/${encodeURIComponent(track.videoId)}`;
    if (!audioCtx) activeDeck.volume = parseFloat(volumeBar.value);
    activeDeck.play().catch((err) => {
      console.warn("HTML5 audio stream blocked or failed. Switching to YouTube player...", err);
      playViaYouTubeEmbed(track.videoId);
    });
  }

  loadTrackMetadata(track);
}

function triggerCrossfade(nextIdx) {
  if (isCrossfading || isUsingYTPlayer || !audioCtx) return;
  const nextTrack = queue[nextIdx];
  if (!nextTrack?.videoId) return;

  isCrossfading = true;
  const outgoingDeck = activeDeck;
  const incomingDeck = inactiveDeck;
  const outgoingNode = deckNodes.get(outgoingDeck);
  const incomingNode = deckNodes.get(incomingDeck);
  const fadeDur = Math.max(1, Number(prefs.crossfadeSec) || 2);

  incomingDeck.src = `/api/stream/${encodeURIComponent(nextTrack.videoId)}`;
  incomingDeck.currentTime = 0;

  incomingDeck.play().then(() => {
    if (outgoingNode && incomingNode && audioCtx) {
      const now = audioCtx.currentTime;
      outgoingNode.deckGain.gain.cancelScheduledValues(now);
      outgoingNode.deckGain.gain.setValueAtTime(outgoingNode.deckGain.gain.value, now);
      outgoingNode.deckGain.gain.linearRampToValueAtTime(0.0, now + fadeDur);

      incomingNode.deckGain.gain.cancelScheduledValues(now);
      incomingNode.deckGain.gain.setValueAtTime(0.0, now);
      incomingNode.deckGain.gain.linearRampToValueAtTime(1.0, now + fadeDur);
    }

    activeDeck = incomingDeck;
    inactiveDeck = outgoingDeck;
    currentIndex = nextIdx;
    currentTrack = nextTrack;
    playNextCount = 0;

    saveQueueState();
    renderQueue();
    updateQueueBadges();
    highlightPlayingRows();
    updateFavoriteButton();
    updateTrackDisplay(nextTrack);
    updateMediaSessionMetadata(nextTrack);
    recordPlay(nextTrack);

    const savedOffset = loadTrackOffset(nextTrack.videoId);
    lyricsEngine.offset = savedOffset;
    updateSyncUI(savedOffset);
    loadTrackMetadata(nextTrack);

    crossfadeCleanupTimer = setTimeout(() => {
      try {
        outgoingDeck.pause();
        outgoingDeck.removeAttribute("src");
        outgoingDeck.load();
      } catch {}
      isCrossfading = false;
    }, fadeDur * 1000 + 180);
  }).catch(() => {
    isCrossfading = false;
  });
}

// ================= PLAYLIST & QUEUE SIDEBAR UI =================
function switchTab(tab) {
  tabDiscover.classList.toggle("active", tab === "discover");
  tabPlaylists.classList.toggle("active", tab === "playlists");
  tabQueue?.classList.toggle("active", tab === "queue");

  discoverPanel.classList.toggle("hidden", tab !== "discover");
  playlistsPanel.classList.toggle("hidden", tab !== "playlists");
  queueSidebarPanel?.classList.toggle("hidden", tab !== "queue");

  if (tab === "playlists") {
    if (openPlaylistId && getPlaylist(openPlaylistId)) renderPlaylistDetail(openPlaylistId);
    else renderPlaylistsHome();
  } else if (tab === "queue") {
    renderQueue();
  }
}

tabDiscover.addEventListener("click", () => switchTab("discover"));
tabPlaylists.addEventListener("click", () => switchTab("playlists"));
tabQueue?.addEventListener("click", () => switchTab("queue"));

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
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const confirmed = await openDialog({
          title: "Delete Playlist",
          message: `Remove "${pl.name}" and its ${pl.tracks.length} track references?`,
          mode: "confirm",
          confirmLabel: "Delete",
          danger: true,
        });
        if (!confirmed) return;
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
  unshuffledQueue = null;
  if (prefs.shuffle) {
    const shuffled = buildShuffledQueue(pl.tracks, -1);
    queue = shuffled.queue;
  } else {
    queue = [...pl.tracks];
  }
  playTrack(0);
});

newPlaylistBtn.addEventListener("click", async () => {
  const name = await openDialog({
    title: "Create Playlist",
    mode: "prompt",
    placeholder: "Late Night Spatial Mix...",
    confirmLabel: "Create",
  });
  if (!name || !String(name).trim()) return;
  const pl = createPlaylist(String(name));
  if (pl) {
    renderPlaylistsHome();
    showToast(`Created "${pl.name}"`);
  }
});

const PROVIDER_META = {
  spotify: { label: "Spotify", badge: "SPOTIFY", cls: "spotify" },
  apple: { label: "Apple Music", badge: "APPLE MUSIC", cls: "apple" },
  youtube: { label: "YouTube", badge: "YOUTUBE", cls: "youtube" },
};

let activeExternalCollection = null;

function getProviderMeta(provider) {
  return PROVIDER_META[provider] || PROVIDER_META.youtube;
}

function hideExternalImportBanner() {
  activeExternalCollection = null;
  extImportBanner?.classList.add("hidden");
}

function showExternalImportBanner({ title, provider, tracks, matchedCount, totalSourceTracks }) {
  if (!extImportBanner || !tracks?.length) return;
  const meta = getProviderMeta(provider);
  activeExternalCollection = { title: title || `${meta.label} Import`, provider, tracks };

  if (extBannerBadge) {
    extBannerBadge.textContent = meta.badge;
    extBannerBadge.className = `ext-provider-badge ${meta.cls}`;
  }
  if (extBannerInfo) {
    const countLabel =
      totalSourceTracks && matchedCount !== undefined && matchedCount < totalSourceTracks
        ? `${matchedCount}/${totalSourceTracks} matched`
        : `${tracks.length} ${tracks.length === 1 ? "song" : "songs"}`;
    extBannerInfo.textContent = `${title || meta.label} (${countLabel})`;
  }
  extImportBanner.classList.remove("hidden");
}

extPlayAllBtn?.addEventListener("click", () => {
  if (!activeExternalCollection?.tracks?.length) return;
  playTrackList(activeExternalCollection.tracks, 0);
});

extQueueAllBtn?.addEventListener("click", () => {
  if (!activeExternalCollection?.tracks?.length) return;
  addTracksToQueue(activeExternalCollection.tracks);
});

extSavePlBtn?.addEventListener("click", () => {
  if (!activeExternalCollection?.tracks?.length) return;
  const { title, tracks } = activeExternalCollection;
  const pl = createPlaylist(title, tracks);
  if (!pl) return;
  switchTab("playlists");
  renderPlaylistDetail(pl.id);
  showToast(`Saved ${pl.tracks.length} songs to "${pl.name}"`);
});

async function fetchImportByUrl(url, provider) {
  const endpoint =
    provider === "spotify" || provider === "apple"
      ? `/api/import-external?url=${encodeURIComponent(url)}`
      : `/api/playlist?url=${encodeURIComponent(url)}`;
  const res = await fetch(endpoint);
  const rawText = await res.text();
  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch {}
  if (!res.ok) {
    throw new Error(data.detail || `Server error (${res.status}).`);
  }
  return data;
}

function renderSingleImportMatchCard(containerEl, track, sourceLabel, sourceBadgeCls) {
  containerEl.innerHTML = "";
  const card = document.createElement("div");
  card.className = "import-single-card";
  card.innerHTML = `
    <div class="import-single-head">
      <img src="${escapeHtml(track.thumbnail)}" referrerpolicy="no-referrer" alt="" />
      <div class="import-single-meta">
        <div class="import-single-title">${escapeHtml(track.title)}</div>
        <div class="import-single-artist">${escapeHtml(track.artist)}</div>
      </div>
      <span class="ext-provider-badge ${sourceBadgeCls}">${escapeHtml(sourceLabel)}</span>
    </div>
    <div class="ext-banner-actions">
      <button type="button" class="ext-banner-btn primary" data-ext-action="play">Play</button>
      <button type="button" class="ext-banner-btn" data-ext-action="queue">Queue</button>
      <button type="button" class="ext-banner-btn" data-ext-action="playlist">+ Playlist</button>
    </div>
  `;
  attachThumbFallback(card.querySelector("img"), track.videoId);

  card.querySelector('[data-ext-action="play"]')?.addEventListener("click", () => {
    playTrackList([track], 0);
  });
  card.querySelector('[data-ext-action="queue"]')?.addEventListener("click", () => {
    addToQueue(track);
  });
  card.querySelector('[data-ext-action="playlist"]')?.addEventListener("click", () => {
    openAddModal(track);
  });
  containerEl.appendChild(card);
}

toggleImportBtn.addEventListener("click", () => {
  importBox.classList.toggle("hidden");
  importStatus.classList.add("hidden");
  importStatus.innerHTML = "";
  if (!importBox.classList.contains("hidden")) importUrlInput.focus();
});

async function runPlaylistImport() {
  const url = importUrlInput.value.trim();
  if (!url) return;

  const provider = detectExternalMusicUrl(url) || "youtube";
  const meta = getProviderMeta(provider);

  importSubmitBtn.disabled = true;
  importStatus.textContent =
    provider === "youtube"
      ? "Importing playlist from YouTube..."
      : `Reading ${meta.label} link & matching on YouTube...`;
  importStatus.classList.remove("hidden");

  try {
    const data = await fetchImportByUrl(url, provider);
    const tracks = data.results || [];

    if (data.kind === "track") {
      if (!tracks.length) {
        throw new Error("Could not find a matching playable track on YouTube.");
      }
      const best = tracks[0];
      renderSingleImportMatchCard(importStatus, best, meta.badge, meta.cls);
      importUrlInput.value = "";
      showToast(`Matched "${best.title}" from ${meta.label}`);
      return;
    }

    const pl = createPlaylist(data.title || `${meta.label} Import`, tracks);
    importUrlInput.value = "";
    importBox.classList.add("hidden");
    importStatus.classList.add("hidden");
    importStatus.innerHTML = "";
    renderPlaylistDetail(pl.id);

    if (data.totalSourceTracks && data.matchedCount < data.totalSourceTracks) {
      showToast(`Imported ${data.matchedCount}/${data.totalSourceTracks} songs into "${pl.name}"`);
    } else {
      showToast(`Imported ${pl.tracks.length} songs into "${pl.name}"`);
    }
  } catch (err) {
    importStatus.textContent = err.message || "Could not import link.";
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

// ================= CUSTOM LRC, SCRIPT TOGGLE & LYRIC QUOTE CARDS =================
let generatedCardBlob = null;
let generatedCardUrl = null;

scriptToggleBtn?.addEventListener("click", () => {
  if (!lyricsEngine.scriptInfo?.hasIndic) return;
  const order = ["original", "roman", "dual"];
  const next = order[(order.indexOf(lyricsEngine.scriptMode) + 1) % order.length];
  saveScriptMode(next);
  const info = lyricsEngine.setScriptMode(next, getCurrentPlaybackTime());
  updateScriptToggleUI(info, next);
  if (next === "roman") showToast("Hinglish romanized lyrics enabled");
  else if (next === "dual") showToast("Dual-Script display enabled");
  else showToast(`Original ${info.label || "script"} lyrics restored`);
});

pasteLrcBtn?.addEventListener("click", () => {
  if (!currentTrack) {
    showToast("Play a track first");
    return;
  }
  lrcModalInput.value = loadCustomLrc(currentTrack.videoId) || "";
  lrcModal?.classList.remove("hidden");
  setTimeout(() => lrcModalInput.focus(), 20);
});

lrcCloseBtn?.addEventListener("click", () => lrcModal?.classList.add("hidden"));
lrcModal?.addEventListener("click", (e) => {
  if (e.target === lrcModal) lrcModal.classList.add("hidden");
});

lrcSaveBtn?.addEventListener("click", () => {
  if (!currentTrack) return;
  const raw = lrcModalInput.value.trim();
  if (!raw) {
    showToast("Paste LRC or plain lyrics first");
    return;
  }
  saveCustomLrc(currentTrack.videoId, raw);
  const parsed = parseClientLrc(raw, currentTrack.duration || 240);
  const scriptInfo = lyricsEngine.load(parsed, lyricsScriptMode);
  updateScriptToggleUI(scriptInfo, lyricsEngine.scriptMode);
  syncBadge.textContent = parsed.synced ? "CUSTOM LRC" : "CUSTOM";
  lrcModal?.classList.add("hidden");
  showToast(parsed.synced ? "Custom synced LRC applied" : "Custom plain lyrics applied");
});

lrcClearBtn?.addEventListener("click", () => {
  if (!currentTrack) return;
  saveCustomLrc(currentTrack.videoId, "");
  lrcModalInput.value = "";
  lrcModal?.classList.add("hidden");
  loadTrackMetadata(currentTrack);
  showToast("Restored automatic lyrics");
});

function setCardSelectionUI(enabled) {
  lyricsEngine.setSelectionMode(enabled);
  lyricCardBtn?.classList.toggle("active", enabled);
  lyricCardBar?.classList.toggle("hidden", !enabled);
}

lyricCardBtn?.addEventListener("click", () => {
  if (!currentTrack || !lyricsEngine.lines.length) {
    showToast("Load a track with lyrics first");
    return;
  }
  setCardSelectionUI(!lyricsEngine.selectionMode);
});

cancelCardBtn?.addEventListener("click", () => setCardSelectionUI(false));

generateCardBtn?.addEventListener("click", async () => {
  const lines = lyricsEngine.getSelectedLines();
  if (!lines.length || !currentTrack) return;
  generateCardBtn.disabled = true;
  try {
    const blob = await renderLyricCardBlob({
      lines,
      title: currentTrack.title,
      artist: currentTrack.artist,
      thumbUrl: currentTrack.thumbnail,
      colors: currentPalette,
    });
    if (!blob) return;

    if (generatedCardUrl) URL.revokeObjectURL(generatedCardUrl);
    generatedCardBlob = blob;
    generatedCardUrl = URL.createObjectURL(blob);
    cardPreviewImg.src = generatedCardUrl;

    const canWebShare = Boolean(
      navigator.share &&
      navigator.canShare &&
      navigator.canShare({ files: [new File([blob], "aura-lyric-card.png", { type: "image/png" })] })
    );
    cardShareBtn?.classList.toggle("hidden", !canWebShare);
    cardModal?.classList.remove("hidden");
    setCardSelectionUI(false);
  } finally {
    generateCardBtn.disabled = false;
  }
});

cardCloseBtn?.addEventListener("click", () => cardModal?.classList.add("hidden"));
cardModal?.addEventListener("click", (e) => {
  if (e.target === cardModal) cardModal.classList.add("hidden");
});

cardDownloadBtn?.addEventListener("click", () => {
  if (!generatedCardUrl) return;
  const a = document.createElement("a");
  a.href = generatedCardUrl;
  const slug = (currentTrack?.title || "aura-lyrics").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  a.download = `${slug}-aura-card.png`;
  a.click();
});

cardShareBtn?.addEventListener("click", async () => {
  if (!generatedCardBlob || !navigator.share) return;
  try {
    const file = new File([generatedCardBlob], "aura-lyric-card.png", { type: "image/png" });
    await navigator.share({
      title: currentTrack ? `${currentTrack.title} — ${currentTrack.artist}` : "AURA Lyrics",
      files: [file],
    });
  } catch {}
});

// ================= SEARCH, EXTERNAL URL & TRENDING =================
let searchTimer = null;
searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim();
  clearSearchBtn.classList.toggle("hidden", !q);
  clearTimeout(searchTimer);
  hideExternalImportBanner();

  if (!q) {
    loadDiscover();
    return;
  }

  const provider = detectExternalMusicUrl(q);
  const delayMs = provider ? 140 : 420;

  searchTimer = setTimeout(async () => {
    if (provider) {
      const meta = getProviderMeta(provider);
      listHeading.textContent = `Resolving ${meta.label} Link...`;
      trackListEl.innerHTML = `<div class="skeleton-loader">Reading ${meta.label} link &amp; matching on YouTube...</div>`;
      try {
        const data = await fetchImportByUrl(q, provider);
        if (searchInput.value.trim() !== q) return;
        const tracks = data.results || [];
        if (data.kind === "track") {
          const srcLabel = data.sourceTrack?.title || data.title || "Track";
          listHeading.textContent = `${meta.label}: ${srcLabel}`;
          renderDiscoverList(tracks, { queueOnlyClicked: true });
        } else {
          const colTitle = data.title || `${meta.label} Import`;
          listHeading.textContent = `${meta.label}: ${colTitle}`;
          showExternalImportBanner({
            title: colTitle,
            provider,
            tracks,
            matchedCount: data.matchedCount ?? tracks.length,
            totalSourceTracks: data.totalSourceTracks ?? tracks.length,
          });
          renderDiscoverList(tracks);
        }
      } catch (err) {
        if (searchInput.value.trim() !== q) return;
        listHeading.textContent = `${meta.label} Import Error`;
        trackListEl.innerHTML = `<div class="skeleton-loader">${escapeHtml(err.message || "Could not resolve that link.")}</div>`;
      }
      return;
    }

    listHeading.textContent = `YouTube Results for "${q}"`;
    trackListEl.innerHTML = `<div class="skeleton-loader">Searching YouTube...</div>`;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (searchInput.value.trim() !== q) return;
      renderDiscoverList(data.results || []);
    } catch {
      trackListEl.innerHTML = `<div class="skeleton-loader">Search failed. Check backend server.</div>`;
    }
  }, delayMs);
});

clearSearchBtn.addEventListener("click", () => {
  searchInput.value = "";
  clearSearchBtn.classList.add("hidden");
  hideExternalImportBanner();
  loadDiscover();
});

async function loadDiscover() {
  hideExternalImportBanner();
  if (hasListeningHistory()) {
    listHeading.textContent = "Recommended For You";
    trackListEl.innerHTML = `<div class="skeleton-loader">Finding songs you'll love...</div>`;
    try {
      const payload = {
        seedVideoIds: getRecentVideoIds(5),
        topArtists: getTopArtists(5),
        excludeIds: getRecentVideoIds(10),
      };
      const res = await fetch("/api/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.results && data.results.length) {
        renderDiscoverList(data.results);
        return;
      }
    } catch (err) {
      console.warn("Recommendations failed, falling back to trending:", err);
    }
  }

  listHeading.textContent = "Curated Spatial Mix";
  trackListEl.innerHTML = `<div class="skeleton-loader">Loading curated mix...</div>`;
  try {
    const res = await fetch("/api/trending");
    const data = await res.json();
    renderDiscoverList(data.results || []);
  } catch {
    trackListEl.innerHTML = `<div class="skeleton-loader">Start the FastAPI backend to browse YouTube.</div>`;
  }
}

// ================= TRANSPORT & AUDIO EVENTS =================
shuffleBtn?.addEventListener("click", toggleShuffle);
repeatBtn?.addEventListener("click", cycleRepeatMode);
autoRadioBtn?.addEventListener("click", toggleAutoRadio);

playBtn.addEventListener("click", () => {
  if (isUsingYTPlayer && ytPlayer && typeof ytPlayer.getPlayerState === "function") {
    const st = ytPlayer.getPlayerState();
    if (st === (window.YT ? YT.PlayerState.PLAYING : 1)) {
      ytPlayer.pauseVideo();
    } else {
      ytPlayer.playVideo();
    }
    return;
  }
  if (!activeDeck.src && !isUsingYTPlayer) {
    if (queue.length > 0 && currentIndex >= 0 && currentIndex < queue.length) {
      playTrack(currentIndex);
      return;
    }
    if (discoverTracks.length) {
      queue = [...discoverTracks];
      playTrack(0);
      return;
    }
  }
  initWebAudio();
  if (activeDeck.paused) activeDeck.play().catch(() => {});
  else activeDeck.pause();
});

prevBtn.addEventListener("click", () => {
  if (getCurrentPlaybackTime() > 3) {
    seekToSeconds(0);
  } else if (currentIndex > 0) {
    playTrack(currentIndex - 1);
  } else if (prefs.repeatMode === "all" && queue.length > 0) {
    playTrack(queue.length - 1);
  }
});

nextBtn.addEventListener("click", () => {
  advanceToNextTrack(false);
});

[audioA, audioB].forEach((deck) => {
  deck.addEventListener("play", () => {
    if (deck !== activeDeck || isUsingYTPlayer) return;
    setPlayingVisualState(true);
    onPlaybackStateChanged(true);
  });

  deck.addEventListener("pause", () => {
    if (deck !== activeDeck || isUsingYTPlayer) return;
    setPlayingVisualState(false);
    onPlaybackStateChanged(false);
  });

  deck.addEventListener("ended", () => {
    if (deck !== activeDeck || isUsingYTPlayer) return;
    handleTrackEnded();
  });

  deck.addEventListener("error", (e) => {
    if (deck !== activeDeck || isUsingYTPlayer) return;
    onPlaybackStateChanged(false);
    const errCode = deck.error ? deck.error.code : "unknown";
    console.warn("Audio playback stream error:", e, "code:", errCode);
    if (currentTrack && !isUsingYTPlayer) {
      playViaYouTubeEmbed(currentTrack.videoId);
      return;
    }
    syncBadge.textContent = "STREAM ERROR";
    showToast("Audio error loading track. Trying next song...");
    setTimeout(() => advanceToNextTrack(true), 2000);
  });
});

seekBar.addEventListener("input", () => {
  isScrubbing = true;
  timeCurrent.textContent = formatTime(parseFloat(seekBar.value));
});

seekBar.addEventListener("change", () => {
  seekToSeconds(parseFloat(seekBar.value));
  isScrubbing = false;
});

volumeBar.addEventListener("input", () => {
  const val = parseFloat(volumeBar.value);
  prefs.volume = val;
  savePrefs();
  if (masterGain) {
    masterGain.gain.value = val;
  } else {
    activeDeck.volume = val;
  }
  if (isUsingYTPlayer && ytPlayer && typeof ytPlayer.setVolume === "function") {
    ytPlayer.setVolume(Math.round(val * 100));
  }
});

vibePills.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-vibe]");
  if (!btn) return;
  const preset = VIBE_PRESETS[btn.dataset.vibe];
  if (preset) applyVibe(preset, false);
});

document.querySelectorAll(".sync-step-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const delta = parseFloat(btn.dataset.delta);
    if (!isNaN(delta)) applyOffsetDelta(delta);
  });
});

offsetVal?.addEventListener("click", resetOffset);

// ================= AUTOMATIC IMMERSIVE CINEMA MODE =================
const CINEMA_AUTO_TRIGGER_MS = 10000;
const CINEMA_IDLE_TIMEOUT_MS = 3000;

let isCinemaMode = false;
let userExitedCinemaManually = false;
let cinemaCountdownTimer = null;
let cinemaIdleTimer = null;

function onPlaybackStateChanged(isPlaying) {
  clearTimeout(cinemaCountdownTimer);
  cinemaCountdownTimer = null;
  if (!isPlaying || isCinemaMode || userExitedCinemaManually) return;

  cinemaCountdownTimer = setTimeout(() => {
    const stillPlaying = isUsingYTPlayer
      ? Boolean(ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() === YT.PlayerState.PLAYING)
      : Boolean(activeDeck && !activeDeck.paused && !activeDeck.ended && Number.isFinite(activeDeck.currentTime) && activeDeck.currentTime > 0);

    if (stillPlaying && !isCinemaMode && !userExitedCinemaManually) {
      enterCinemaMode(true);
    }
  }, CINEMA_AUTO_TRIGGER_MS);
}

function enterCinemaMode(isAuto = false) {
  if (isCinemaMode) return;
  isCinemaMode = true;
  clearTimeout(cinemaCountdownTimer);
  cinemaCountdownTimer = null;

  appShell.classList.add("cinema-mode");
  cinemaHud?.classList.remove("hidden");
  if (immersionBtn) immersionBtn.textContent = "Exit Cinema";

  try {
    if (!document.fullscreenElement) {
      const p = document.documentElement.requestFullscreen?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  } catch {}

  setTimeout(() => window.dispatchEvent(new Event("resize")), 250);
  setTimeout(() => window.dispatchEvent(new Event("resize")), 550);
  resetCinemaInactivity();
  if (isAuto) showToast("Cinema Mode activated");
}

function exitCinemaMode(manual = true) {
  if (!isCinemaMode) return;
  isCinemaMode = false;
  if (manual) userExitedCinemaManually = true;

  clearTimeout(cinemaCountdownTimer);
  clearTimeout(cinemaIdleTimer);
  cinemaCountdownTimer = null;
  cinemaIdleTimer = null;

  appShell.classList.remove("cinema-mode", "cinema-idle");
  cinemaHud?.classList.add("hidden");
  if (immersionBtn) immersionBtn.textContent = "Cinema Mode";

  if (document.fullscreenElement) {
    try { document.exitFullscreen?.().catch(() => {}); } catch {}
  }

  setTimeout(() => window.dispatchEvent(new Event("resize")), 250);
  setTimeout(() => window.dispatchEvent(new Event("resize")), 550);
  if (manual) showToast("Restored sidebar and playlist view");
}

function resetCinemaInactivity() {
  if (!isCinemaMode) return;
  appShell.classList.remove("cinema-idle");
  clearTimeout(cinemaIdleTimer);
  cinemaIdleTimer = setTimeout(() => {
    if (isCinemaMode) appShell.classList.add("cinema-idle");
  }, CINEMA_IDLE_TIMEOUT_MS);
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().then(() => updateFullscreenBtnState(true)).catch(() => {
      showToast("Fullscreen not allowed by browser");
    });
  } else {
    document.exitFullscreen?.().then(() => updateFullscreenBtnState(false)).catch(() => {});
  }
}

function updateFullscreenBtnState(isFs) {
  const expandIcon = cinemaFsBtn?.querySelector(".fs-expand");
  const compressIcon = cinemaFsBtn?.querySelector(".fs-compress");
  const fsText = cinemaFsBtn?.querySelector(".fs-text");
  if (expandIcon) expandIcon.classList.toggle("hidden", isFs);
  if (compressIcon) compressIcon.classList.toggle("hidden", !isFs);
  if (fsText) fsText.textContent = isFs ? "Exit Fullscreen" : "Fullscreen";
}

document.addEventListener("fullscreenchange", () => updateFullscreenBtnState(Boolean(document.fullscreenElement)));
window.addEventListener("mousemove", () => { if (isCinemaMode) resetCinemaInactivity(); }, { passive: true });
window.addEventListener("touchstart", () => { if (isCinemaMode) resetCinemaInactivity(); }, { passive: true });

immersionBtn?.addEventListener("click", () => (isCinemaMode ? exitCinemaMode(true) : enterCinemaMode(false)));
cinemaExitBtn?.addEventListener("click", (e) => { e.stopPropagation(); exitCinemaMode(true); });
cinemaFsBtn?.addEventListener("click", (e) => { e.stopPropagation(); toggleFullscreen(); });
cinemaQueueBtn?.addEventListener("click", (e) => { e.stopPropagation(); toggleQueueDrawer(); });
queueToggleBtn?.addEventListener("click", (e) => { e.stopPropagation(); toggleQueueDrawer(); });
headerQueueBtn?.addEventListener("click", (e) => { e.stopPropagation(); toggleQueueDrawer(); });
queueCloseBtn?.addEventListener("click", () => toggleQueueDrawer(false));
queueBackdrop?.addEventListener("click", () => toggleQueueDrawer(false));
queueClearBtn?.addEventListener("click", clearQueue);
sidebarQueueClearBtn?.addEventListener("click", clearQueue);

// Context Menu Listeners
contextMenu?.addEventListener("click", (e) => {
  const item = e.target.closest(".context-menu-item");
  if (!item || !activeContextTrack) return;
  const action = item.dataset.action;

  if (action === "play-now") {
    unshuffledQueue = null;
    if (activeContextOptions?.sourceList && typeof activeContextOptions?.index === "number") {
      queue = [...activeContextOptions.sourceList];
      playTrack(activeContextOptions.index);
    } else {
      queue = [activeContextTrack];
      playTrack(0);
    }
    closeContextMenu();
  } else if (action === "play-next") {
    playNext(activeContextTrack);
    closeContextMenu();
  } else if (action === "add-queue") {
    addToQueue(activeContextTrack);
    closeContextMenu();
  } else if (action === "add-playlist") {
    const tr = activeContextTrack;
    closeContextMenu();
    openAddModal(tr);
  } else if (action === "remove-item") {
    if (activeContextOptions?.removable && activeContextOptions?.playlistId) {
      removeTrackFromPlaylist(activeContextOptions.playlistId, activeContextTrack.videoId);
    } else if (activeContextOptions?.queueIndex !== undefined) {
      removeFromQueue(activeContextOptions.queueIndex);
    }
    closeContextMenu();
  }
});

window.addEventListener("click", (e) => {
  if (contextMenu && !contextMenu.classList.contains("hidden")) {
    if (!e.target.closest("#context-menu") && !e.target.closest(".track-menu-btn")) {
      closeContextMenu();
    }
  }
});
window.addEventListener("scroll", closeContextMenu, { passive: true });

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  if (e.key === "Escape" || e.code === "Escape") {
    if (contextMenu && !contextMenu.classList.contains("hidden")) { closeContextMenu(); return; }
    if (dialogModal && !dialogModal.classList.contains("hidden")) { closeDialog(null); return; }
    if (audioFxModal && !audioFxModal.classList.contains("hidden")) { audioFxModal.classList.add("hidden"); return; }
    if (lrcModal && !lrcModal.classList.contains("hidden")) { lrcModal.classList.add("hidden"); return; }
    if (cardModal && !cardModal.classList.contains("hidden")) { cardModal.classList.add("hidden"); return; }
    if (queueDrawer && !queueDrawer.classList.contains("hidden")) { toggleQueueDrawer(false); return; }
    if (isCinemaMode) { exitCinemaMode(true); return; }
  }

  if (isCinemaMode) resetCinemaInactivity();
  if (e.code === "Space") {
    e.preventDefault();
    playBtn.click();
  } else if (e.code === "ArrowRight") {
    seekToSeconds(getCurrentPlaybackTime() + 5);
  } else if (e.code === "ArrowLeft") {
    seekToSeconds(Math.max(0, getCurrentPlaybackTime() - 5));
  } else if (e.key === "[") {
    e.preventDefault();
    applyOffsetDelta(e.shiftKey ? -0.50 : -0.10);
  } else if (e.key === "]") {
    e.preventDefault();
    applyOffsetDelta(e.shiftKey ? 0.50 : 0.10);
  } else if (e.key === "\\") {
    e.preventDefault();
    resetOffset();
  } else if (e.key === "s" || e.key === "S") {
    toggleShuffle();
  } else if (e.key === "r" || e.key === "R") {
    cycleRepeatMode();
  }
});

// ================= 60FPS SYNC LOOP =================
function mainLoop(now) {
  requestAnimationFrame(mainLoop);

  const isYtPlaying = Boolean(
    isUsingYTPlayer &&
    ytPlayer &&
    typeof ytPlayer.getPlayerState === "function" &&
    ytPlayer.getPlayerState() === (window.YT ? YT.PlayerState.PLAYING : 1)
  );
  const isPlaying = isYtPlaying || !activeDeck.paused;
  const curTime = getCurrentPlaybackTime();
  const effectiveDuration = getEffectiveDuration();

  // Check dual-deck crossfade trigger for direct streams
  if (
    !isUsingYTPlayer &&
    !isCrossfading &&
    prefs.crossfadeSec > 0 &&
    !activeDeck.paused &&
    Number.isFinite(activeDeck.duration) &&
    activeDeck.duration > prefs.crossfadeSec + 3
  ) {
    const remaining = activeDeck.duration - activeDeck.currentTime;
    if (remaining > 0 && remaining <= prefs.crossfadeSec) {
      const nextIdx = getNextTrackIndex();
      if (nextIdx !== null && nextIdx !== currentIndex) {
        triggerCrossfade(nextIdx);
      }
    }
  }

  if (isPlaying) {
    let bNorm = 0;
    let mNorm = 0;
    let hNorm = 0;

    if (!isUsingYTPlayer && analyser && freqData) {
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
    if (fftSilent || isUsingYTPlayer) {
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
      const level = (fftSilent || isUsingYTPlayer)
        ? 0.25 + 0.65 * Math.abs(Math.sin(t * (1.2 + i * 0.35) + i))
        : Math.max(0.18, (freqData[bins[i]] || 0) / 255);
      bar.style.height = `${Math.round(level * 100)}%`;
    });

    drawCoverSpectrumHalo(now, bNorm, mNorm, hNorm, true);
    updateMediaSessionPosition(false);
  } else {
    smoothBass *= 0.85;
    smoothMid *= 0.85;
    scene3D.updateAudio(0.05, 0.04, 0.02);
    artContainer.style.setProperty("--bass", smoothBass.toFixed(3));
    artContainer.style.setProperty("--mid", smoothMid.toFixed(3));
    eqBars.forEach((bar) => { bar.style.height = "22%"; });
    drawCoverSpectrumHalo(now, 0.03, 0.02, 0.02, false);
  }

  if (effectiveDuration > 0) {
    seekBar.max = effectiveDuration;
    timeTotal.textContent = formatTime(effectiveDuration);
  }

  if (!isScrubbing && Number.isFinite(curTime)) {
    seekBar.value = curTime;
    timeCurrent.textContent = formatTime(curTime);
  }

  if (miniProgressFill && effectiveDuration > 0 && Number.isFinite(curTime)) {
    const pct = Math.min(100, Math.max(0, (curTime / effectiveDuration) * 100));
    miniProgressFill.style.width = `${pct.toFixed(2)}%`;
  }

  if (Number.isFinite(curTime) && (curTime > 0 || isPlaying)) {
    lyricsEngine.update(curTime);
  }
}

let activeHaloAccent1 = "#ec4899";
let activeHaloAccent2 = "#06b6d4";

function drawCoverSpectrumHalo(now, bass, mid, high, isPlaying) {
  if (!coverHaloCanvas || !coverHaloCtx || prefs.spectrumHalo === false || document.hidden) return;

  const rect = coverHaloCanvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);
  if (coverHaloCanvas.width !== targetW || coverHaloCanvas.height !== targetH) {
    coverHaloCanvas.width = targetW;
    coverHaloCanvas.height = targetH;
  }

  const ctx = coverHaloCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const inten = prefs.visualIntensity === "minimal" ? 0.38 : prefs.visualIntensity === "vivid" ? 1.45 : 1.0;
  if (!isPlaying && smoothBass < 0.01) return;

  const styles = getComputedStyle(document.documentElement);
  activeHaloAccent1 = styles.getPropertyValue("--accent-1").trim() || activeHaloAccent1;
  activeHaloAccent2 = styles.getPropertyValue("--accent-2").trim() || activeHaloAccent2;

  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const baseHalf = Math.min(cx, cy) - 34;
  if (baseHalf <= 16) return;

  const bars = 68;
  const phaseShift = now * 0.0008;
  const grad = ctx.createLinearGradient(0, 0, rect.width, rect.height);
  grad.addColorStop(0, activeHaloAccent1);
  grad.addColorStop(1, activeHaloAccent2);

  const squircle = (theta, radius) => {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    return {
      x: cx + Math.sign(c) * Math.pow(Math.abs(c), 0.28) * radius,
      y: cy + Math.sign(s) * Math.pow(Math.abs(s), 0.28) * radius,
    };
  };

  // Subtle squircle orbital perimeter hugging the rounded album art
  ctx.save();
  ctx.strokeStyle = grad;
  ctx.globalAlpha = Math.min(0.6, (0.14 + smoothBass * 0.34) * inten);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i <= 72; i++) {
    const pt = squircle((i / 72) * Math.PI * 2, baseHalf);
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  }
  ctx.closePath();
  ctx.stroke();

  // Radial spectrum rays extending smoothly from the squircle perimeter
  ctx.lineCap = "round";
  ctx.lineWidth = 2.4;
  ctx.globalAlpha = Math.min(0.85, (isPlaying ? 0.58 : 0.18) * inten);

  const hasLiveFFT = !isUsingYTPlayer && analyser && freqData && freqData.length >= 64 && bass + mid + high >= 0.01;
  for (let i = 0; i < bars; i++) {
    const theta = (i / bars) * Math.PI * 2;
    let amp;
    if (hasLiveFFT) {
      const binIdx = 2 + Math.floor((i % (bars / 2)) * 2.1);
      amp = (freqData[binIdx] || 0) / 255;
    } else {
      const t = now * 0.003;
      const wave1 = Math.abs(Math.sin(i * 0.35 + t * 1.4 + phaseShift));
      const wave2 = Math.abs(Math.cos(i * 0.65 - t * 1.9));
      amp = (wave1 * 0.55 + wave2 * 0.45) * (0.3 + smoothBass * 0.75 + smoothMid * 0.35);
    }

    const barLen = Math.min(24, (3 + amp * 16) * inten);
    const ptIn = squircle(theta, baseHalf + 1);
    const nx = ptIn.x - cx;
    const ny = ptIn.y - cy;
    const nLen = Math.hypot(nx, ny) || 1;

    ctx.beginPath();
    ctx.moveTo(ptIn.x, ptIn.y);
    ctx.lineTo(ptIn.x + (nx / nLen) * barLen, ptIn.y + (ny / nLen) * barLen);
    ctx.stroke();
  }
  ctx.restore();
}

// ================= MOBILE NAVIGATION & MUTE =================
function toggleMute() {
  if (isUsingYTPlayer && ytPlayer) {
    const isMuted = typeof ytPlayer.isMuted === "function" ? ytPlayer.isMuted() : false;
    if (isMuted) {
      if (typeof ytPlayer.unMute === "function") ytPlayer.unMute();
      const restoreVol = previousVolume || 0.85;
      volumeBar.value = String(restoreVol);
      if (typeof ytPlayer.setVolume === "function") ytPlayer.setVolume(Math.round(restoreVol * 100));
    } else {
      previousVolume = parseFloat(volumeBar.value) || 0.85;
      if (typeof ytPlayer.mute === "function") ytPlayer.mute();
      volumeBar.value = "0";
    }
    return;
  }

  const currentVol = parseFloat(volumeBar.value);
  if (currentVol > 0) {
    previousVolume = currentVol;
    volumeBar.value = "0";
    if (masterGain) masterGain.gain.value = 0;
    else activeDeck.volume = 0;
  } else {
    const restored = previousVolume || 0.85;
    volumeBar.value = String(restored);
    if (masterGain) masterGain.gain.value = restored;
    else activeDeck.volume = restored;
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
  } else if (mobileView !== "player" && currentTrack) {
    mobileMiniPlayer?.classList.remove("hidden");
  }
});

// ================= INIT & SERVICE WORKER =================
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

initMediaSession();
updateTransportModeUI();
syncAudioFxUI();
applyVisualPreferences();
loadQueueState();
renderQueue();
updateQueueBadges();
loadDiscover();
requestAnimationFrame(mainLoop);
