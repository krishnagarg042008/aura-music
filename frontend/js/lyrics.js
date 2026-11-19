export class LyricsEngine {
  constructor(viewportEl, containerEl, onSeek) {
    this.viewport = viewportEl;
    this.container = containerEl;
    this.onSeek = onSeek;

    this.lines = [];
    this.lineNodes = [];
    this.wordNodes = [];
    this.synced = false;
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
    }, 3000);
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

    let nextActive = -1;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (t >= this.lines[i].start - 0.08) {
        nextActive = i;
        break;
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
          const pct = Math.min(100, Math.max(0, ((t - w.start) / Math.max(0.05, w.end - w.start)) * 100));
          span.style.setProperty("--fill", `${pct.toFixed(1)}%`);
          span.classList.add("word-active");
        }
      }
    }
  }
}