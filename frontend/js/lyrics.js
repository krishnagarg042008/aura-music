/**
 * AURA Lyrics Engine — word-by-word karaoke-style highlight with smooth fill.
 *
 * Capabilities:
 *  - High-precision word-level and line-level highlight.
 *  - Handles instrumental pauses: when a line has ended and there is an interlude
 *    before the next line, the previous line dims to past and no line is active.
 *  - Handles unsynced plain lyrics gracefully (clean, readable text with smooth scrolling).
 *  - Auto-scroll centers the active line at ~36% from the top of the viewport.
 */

export class LyricsEngine {
  constructor(viewportEl, containerEl, onSeek) {
    this.viewport = viewportEl;
    this.container = containerEl;
    this.onSeek = onSeek;

    this.lines = [];
    this.lineNodes = [];
    this.wordNodes = [];
    this.synced = false;
    this.wordNative = false;
    this.activeLineIdx = -1;
    this.offset = 0.0;
    this.userScrolling = false;
    this.scrollTimer = null;

    this.viewport.addEventListener("wheel", () => this._pauseAutoScroll(), { passive: true });
    this.viewport.addEventListener("touchstart", () => this._pauseAutoScroll(), { passive: true });
  }

  _pauseAutoScroll() {
    this.userScrolling = true;
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      this.userScrolling = false;
    }, 3500);
  }

  setOffset(delta) {
    this.offset = Math.round((this.offset + delta) * 100) / 100;
    return this.offset;
  }

  resetOffset() {
    this.offset = 0.0;
  }

  load(lyricsData) {
    this.lines = lyricsData?.lines || [];
    this.synced = Boolean(lyricsData?.synced);
    this.wordNative = Boolean(lyricsData?.word_native);
    this.activeLineIdx = -1;
    this.lineNodes = [];
    this.wordNodes = [];
    this.userScrolling = false;
    this.container.innerHTML = "";

    if (!this.lines.length) {
      this.container.innerHTML = `<p class="lyrics-empty">No lyrics found for this track — enjoy the spatial visualizer.</p>`;
      return;
    }

    const frag = document.createDocumentFragment();

    this.lines.forEach((line) => {
      const p = document.createElement("div");
      p.className = "lyric-line";
      if (!this.synced) {
        p.classList.add("active");
        p.style.opacity = "0.85";
      }

      const wNodes = [];
      (line.words || []).forEach((w) => {
        const span = document.createElement("span");
        span.className = "lyric-word";
        span.textContent = w.text;
        if (!this.synced) span.style.setProperty("--fill", "100%");
        p.appendChild(span);
        wNodes.push(span);
      });

      if (this.synced && line.start >= 0) {
        p.addEventListener("click", () => {
          this.userScrolling = false;
          this.onSeek(Math.max(0, line.start - this.offset));
        });
      }

      frag.appendChild(p);
      this.lineNodes.push(p);
      this.wordNodes.push(wNodes);
    });

    this.container.appendChild(frag);
    this.viewport.scrollTop = 0;
  }

  _scrollToLine(lineEl) {
    const vpRect = this.viewport.getBoundingClientRect();
    const elRect = lineEl.getBoundingClientRect();
    const targetTop = this.viewport.scrollTop + (elRect.top - vpRect.top) - vpRect.height * 0.36;
    this.viewport.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
  }

  update(rawTime) {
    if (!this.synced || !this.lines.length) return;
    const t = rawTime + this.offset;

    // Find candidate active line (last line whose start ≤ t + small pre-window).
    let nextActive = -1;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (t >= this.lines[i].start - 0.12) {
        nextActive = i;
        break;
      }
    }

    // Instrumental break check: if current line has ended and next line hasn't started yet
    if (nextActive >= 0) {
      const curLine = this.lines[nextActive];
      const nextLine = nextActive + 1 < this.lines.length ? this.lines[nextActive + 1] : null;
      if (t > curLine.end + 0.35 && (!nextLine || t < nextLine.start - 0.15)) {
        // In interlude between lines: complete the previous line and clear active state
        this.lineNodes.forEach((node, idx) => {
          node.classList.remove("active");
          node.classList.toggle("past", idx <= nextActive);
          if (idx <= nextActive) {
            this.wordNodes[idx].forEach((wn) => {
              wn.style.setProperty("--fill", "100%");
              wn.classList.remove("word-active");
            });
          }
        });
        this.activeLineIdx = -1;
        return;
      }
    }

    if (nextActive !== this.activeLineIdx) {
      this.activeLineIdx = nextActive;

      this.lineNodes.forEach((node, idx) => {
        node.classList.toggle("active", idx === nextActive);
        node.classList.toggle("past", idx < nextActive);

        if (idx < nextActive) {
          this.wordNodes[idx].forEach((wn) => {
            wn.style.setProperty("--fill", "100%");
            wn.classList.remove("word-active");
          });
        } else if (idx > nextActive) {
          this.wordNodes[idx].forEach((wn) => {
            wn.style.setProperty("--fill", "0%");
            wn.classList.remove("word-active");
          });
        }
      });

      if (nextActive >= 0 && !this.userScrolling) {
        this._scrollToLine(this.lineNodes[nextActive]);
      }
    }

    // Word-level fill within the active line.
    if (nextActive >= 0) {
      const words = this.lines[nextActive].words || [];
      const spans = this.wordNodes[nextActive];

      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const span = spans[i];
        if (!span) continue;

        if (t < w.start) {
          span.style.setProperty("--fill", "0%");
          span.classList.remove("word-active");
        } else if (t >= w.end) {
          span.style.setProperty("--fill", "100%");
          span.classList.remove("word-active");
        } else {
          const progress = (t - w.start) / Math.max(0.05, w.end - w.start);
          const pct = Math.min(100, Math.max(0, progress * 100));
          span.style.setProperty("--fill", `${pct.toFixed(1)}%`);
          span.classList.add("word-active");
        }
      }
    }
  }
}
