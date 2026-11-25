/**
 * AURA Lyrics Engine — word-by-word karaoke-style highlight with smooth fill,
 * interlude throttling, lyric selection mode, and PNG quote card generation.
 */

export class LyricsEngine {
  constructor(viewportEl, containerEl, onSeek, onSelectionChange = null) {
    this.viewport = viewportEl;
    this.container = containerEl;
    this.onSeek = onSeek;
    this.onSelectionChange = onSelectionChange;

    this.lines = [];
    this.lineNodes = [];
    this.wordNodes = [];
    this.wordLastFill = [];
    this.synced = false;
    this.wordNative = false;
    this.activeLineIdx = -1;
    this.offset = 0.0;
    this.userScrolling = false;
    this.scrollTimer = null;

    // Lyric card selection state
    this.selectionMode = false;
    this.selectedLineIndices = new Set();

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

  setSelectionMode(enabled) {
    this.selectionMode = Boolean(enabled);
    if (!this.selectionMode) {
      this.selectedLineIndices.clear();
      this.lineNodes.forEach((n) => n.classList.remove("selected-for-card"));
    }
    this.container.classList.toggle("selection-mode", this.selectionMode);
    this.onSelectionChange?.(this.getSelectedLines());
  }

  getSelectedLines() {
    return Array.from(this.selectedLineIndices)
      .sort((a, b) => a - b)
      .map((i) => this.lines[i]?.text)
      .filter(Boolean);
  }

  _toggleLineSelection(idx) {
    const node = this.lineNodes[idx];
    if (!node) return;

    if (this.selectedLineIndices.has(idx)) {
      this.selectedLineIndices.delete(idx);
      node.classList.remove("selected-for-card");
    } else {
      if (this.selectedLineIndices.size >= 4) {
        const first = this.selectedLineIndices.values().next().value;
        this.selectedLineIndices.delete(first);
        this.lineNodes[first]?.classList.remove("selected-for-card");
      }
      this.selectedLineIndices.add(idx);
      node.classList.add("selected-for-card");
    }

    this.onSelectionChange?.(this.getSelectedLines());
  }

  load(lyricsData) {
    this.lines = lyricsData?.lines || [];
    this.synced = Boolean(lyricsData?.synced);
    this.wordNative = Boolean(lyricsData?.word_native);
    this.activeLineIdx = -1;
    this.lineNodes = [];
    this.wordNodes = [];
    this.wordLastFill = [];
    this.userScrolling = false;
    this.selectedLineIndices.clear();
    this.container.innerHTML = "";
    this.onSelectionChange?.([]);

    if (!this.lines.length) {
      this.container.innerHTML = `<p class="lyrics-empty">No lyrics found for this track — paste custom LRC or enjoy the spatial visualizer.</p>`;
      return;
    }

    const frag = document.createDocumentFragment();

    this.lines.forEach((line, idx) => {
      const p = document.createElement("div");
      p.className = "lyric-line";
      if (!this.synced) {
        p.classList.add("active");
        p.style.opacity = "0.85";
      }

      const wNodes = [];
      const wFills = [];
      (line.words || []).forEach((w) => {
        const span = document.createElement("span");
        span.className = "lyric-word";
        span.textContent = w.text;
        if (!this.synced) {
          span.style.setProperty("--fill", "100%");
          wFills.push(100);
        } else {
          wFills.push(0);
        }
        p.appendChild(span);
        wNodes.push(span);
      });

      p.addEventListener("click", () => {
        if (this.selectionMode) {
          this._toggleLineSelection(idx);
          return;
        }
        if (this.synced && line.start >= 0) {
          this.userScrolling = false;
          this.onSeek(Math.max(0, line.start - this.offset));
        }
      });

      frag.appendChild(p);
      this.lineNodes.push(p);
      this.wordNodes.push(wNodes);
      this.wordLastFill.push(wFills);
    });

    this.container.appendChild(frag);
    this.viewport.scrollTop = 0;
  }

  _setWordFill(lineIdx, wordIdx, pct) {
    const span = this.wordNodes[lineIdx]?.[wordIdx];
    if (!span) return;
    const prev = this.wordLastFill[lineIdx]?.[wordIdx];
    const rounded = Math.round(pct * 10) / 10;
    if (prev !== undefined && Math.abs(rounded - prev) < 0.5 && rounded !== 0 && rounded !== 100) {
      return;
    }
    if (prev === rounded) return;
    this.wordLastFill[lineIdx][wordIdx] = rounded;
    span.style.setProperty("--fill", `${rounded.toFixed(1)}%`);
  }

  _scrollToLine(lineEl) {
    if (document.hidden || !lineEl) return;
    const vpHeight = this.viewport.clientHeight;
    const targetTop = lineEl.offsetTop - vpHeight * 0.36;
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
      if (t >= this.lines[i].start - 0.12) {
        nextActive = i;
        break;
      }
    }

    // Instrumental break check: only update DOM once upon entering the interlude
    if (nextActive >= 0) {
      const curLine = this.lines[nextActive];
      const nextLine = nextActive + 1 < this.lines.length ? this.lines[nextActive + 1] : null;
      if (t > curLine.end + 0.35 && (!nextLine || t < nextLine.start - 0.15)) {
        if (this.activeLineIdx !== -1) {
          this.lineNodes.forEach((node, idx) => {
            node.classList.remove("active");
            node.classList.toggle("past", idx <= nextActive);
            if (idx <= nextActive) {
              this.wordNodes[idx].forEach((wn, wIdx) => {
                this._setWordFill(idx, wIdx, 100);
                wn.classList.remove("word-active");
              });
            }
          });
          this.activeLineIdx = -1;
        }
        return;
      }
    }

    if (nextActive !== this.activeLineIdx) {
      this.activeLineIdx = nextActive;

      this.lineNodes.forEach((node, idx) => {
        node.classList.toggle("active", idx === nextActive);
        node.classList.toggle("past", idx < nextActive);

        if (idx < nextActive) {
          this.wordNodes[idx].forEach((wn, wIdx) => {
            this._setWordFill(idx, wIdx, 100);
            wn.classList.remove("word-active");
          });
        } else if (idx > nextActive) {
          this.wordNodes[idx].forEach((wn, wIdx) => {
            this._setWordFill(idx, wIdx, 0);
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
          this._setWordFill(nextActive, i, 0);
          span.classList.remove("word-active");
        } else if (t >= w.end) {
          this._setWordFill(nextActive, i, 100);
          span.classList.remove("word-active");
        } else {
          const progress = (t - w.start) / Math.max(0.05, w.end - w.start);
          const pct = Math.min(100, Math.max(0, progress * 100));
          this._setWordFill(nextActive, i, pct);
          span.classList.add("word-active");
        }
      }
    }
  }
}

/**
 * Render a stylized 1080x1350 Lyric Quote Card PNG blob for downloading or sharing.
 */
export async function renderLyricCardBlob({ lines, title, artist, thumbUrl, colors }) {
  const width = 1080;
  const height = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const [bgBase, accent1, accent2] = colors && colors.length >= 3
    ? colors
    : ["#0f0728", "#ec4899", "#06b6d4"];

  // Ambient gradient backdrop
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, bgBase);
  grad.addColorStop(0.55, "#0b0d17");
  grad.addColorStop(1, bgBase);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Glow orbs
  const orb1 = ctx.createRadialGradient(220, 260, 10, 220, 260, 520);
  orb1.addColorStop(0, `${accent1}66`);
  orb1.addColorStop(1, "transparent");
  ctx.fillStyle = orb1;
  ctx.fillRect(0, 0, width, height);

  const orb2 = ctx.createRadialGradient(880, 1050, 10, 880, 1050, 560);
  orb2.addColorStop(0, `${accent2}55`);
  orb2.addColorStop(1, "transparent");
  ctx.fillStyle = orb2;
  ctx.fillRect(0, 0, width, height);

  // Glass card panel
  const pad = 76;
  const cardW = width - pad * 2;
  const cardH = height - pad * 2;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(pad, pad, cardW, cardH, 46);
  ctx.fillStyle = "rgba(14, 17, 29, 0.72)";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.stroke();
  ctx.restore();

  // Header: Album Art + Track Meta
  const headerX = pad + 60;
  const headerY = pad + 64;
  const artSize = 132;

  if (thumbUrl) {
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.crossOrigin = "anonymous";
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = thumbUrl;
      });
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(headerX, headerY, artSize, artSize, 24);
      ctx.clip();
      ctx.drawImage(img, headerX, headerY, artSize, artSize);
      ctx.restore();
    } catch {
      ctx.fillStyle = accent1;
      ctx.beginPath();
      ctx.roundRect(headerX, headerY, artSize, artSize, 24);
      ctx.fill();
    }
  }

  ctx.fillStyle = "#ffffff";
  ctx.font = "700 36px Inter, system-ui, sans-serif";
  const maxMetaW = cardW - 120 - artSize - 32;
  ctx.fillText(truncateText(ctx, title || "Unknown Track", maxMetaW), headerX + artSize + 30, headerY + 56);

  ctx.fillStyle = "rgba(255,255,255,0.68)";
  ctx.font = "500 28px Inter, system-ui, sans-serif";
  ctx.fillText(truncateText(ctx, artist || "", maxMetaW), headerX + artSize + 30, headerY + 100);

  // Lyric lines wrapped nicely
  ctx.fillStyle = "#ffffff";
  const quoteLines = [];
  const quoteFontSize = lines.length <= 2 ? 56 : 46;
  ctx.font = `700 ${quoteFontSize}px "Space Grotesk", Inter, sans-serif`;
  const textMaxW = cardW - 128;

  for (const raw of lines) {
    const wrapped = wrapCanvasText(ctx, raw, textMaxW);
    quoteLines.push(...wrapped, "");
  }
  if (quoteLines[quoteLines.length - 1] === "") quoteLines.pop();

  const lineH = quoteFontSize * 1.38;
  const totalTextH = quoteLines.length * lineH;
  let y = Math.max(headerY + artSize + 95, (height - totalTextH) / 2 + 20);

  for (const ql of quoteLines) {
    if (ql === "") {
      y += lineH * 0.45;
      continue;
    }
    ctx.fillText(ql, headerX, y);
    y += lineH;
  }

  // Footer branding
  ctx.fillStyle = accent2;
  ctx.font = "700 26px Inter, system-ui, sans-serif";
  ctx.fillText("✦ AURA SPATIAL MUSIC", headerX, pad + cardH - 56);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function truncateText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxW) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

function wrapCanvasText(ctx, text, maxW) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (ctx.measureText(candidate).width > maxW && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}
