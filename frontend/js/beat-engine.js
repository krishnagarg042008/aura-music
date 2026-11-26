/**
 * AURA Beat Sync Engine — real-time WebAudio onset/kick detection,
 * live BPM clustering with octave folding, PLL beat-phase tracking,
 * Tap Tempo, and BPM-locked fallback synthesis for YouTube Embed playback.
 */

export const VIBE_DEFAULT_BPM = {
  chill: 84,
  melancholy: 76,
  spiritual: 72,
  romantic: 88,
  cosmic: 96,
  anime: 128,
  synth: 118,
  rock: 132,
  hype: 136,
};

export const VIBE_BEAT_GAIN = {
  chill: 0.58,
  melancholy: 0.52,
  spiritual: 0.55,
  romantic: 0.72,
  cosmic: 0.85,
  anime: 0.95,
  synth: 1.08,
  rock: 1.22,
  hype: 1.30,
};

export const BEAT_INTENSITY_GAIN = {
  subtle: 0.55,
  balanced: 1.0,
  punchy: 1.45,
};

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function foldBpm(bpm) {
  let b = bpm;
  if (!Number.isFinite(b) || b <= 0) return 120;
  while (b < 66) b *= 2;
  while (b > 174) b /= 2;
  return b;
}

export class BeatEngine {
  constructor() {
    this.historySize = 43; // ~0.72s rolling baseline at 60fps
    this.minBeatMs = 265;  // ~226 BPM ceiling against double-triggers
    this.resetTrack(0);
  }

  resetTrack(savedTapBpm = 0) {
    this.prevSpectrum = null;
    this.prevKickEnergy = 0;
    this.prevOnsetSignal = 0;
    this.onsetHistory = [];
    this.kickHistory = [];
    this.ioiHistory = [];

    this.lastFrameMs = null;
    this.lastOnsetMs = -Infinity;
    this.lastClockBeatMs = -Infinity;

    this.liveBpm = 0;
    this.bpmConfidence = 0;
    this.tapBpm = savedTapBpm > 0 ? clamp(Math.round(savedTapBpm), 45, 220) : 0;
    this.tapTimes = [];

    this.beatPhase = 0;
    this.beatPulse = 0;
    this.downbeatPulse = 0;
    this.beatCount = 0;
    this.wasPlaying = false;
  }

  onSeek() {
    this.lastOnsetMs = -Infinity;
    this.prevOnsetSignal = 0;
    this.prevKickEnergy = 0;
  }

  tap(nowMs = performance.now()) {
    if (this.tapTimes.length > 0 && nowMs - this.tapTimes[this.tapTimes.length - 1] > 2000) {
      this.tapTimes = [];
    }
    this.tapTimes.push(nowMs);
    if (this.tapTimes.length > 6) {
      this.tapTimes.shift();
    }

    if (this.tapTimes.length >= 2) {
      let sum = 0;
      for (let i = 1; i < this.tapTimes.length; i++) {
        sum += this.tapTimes[i] - this.tapTimes[i - 1];
      }
      const avgDt = sum / (this.tapTimes.length - 1);
      if (avgDt > 0) {
        this.tapBpm = clamp(Math.round(60000 / avgDt), 45, 220);
      }
    }

    // Align downbeat immediately to the user's tap
    this.beatPhase = 0;
    this.beatPulse = 1.0;
    this.downbeatPulse = 1.0;
    this.beatCount += 1;
    this.lastClockBeatMs = nowMs;

    return {
      tapBpm: this.tapBpm,
      tapsCount: this.tapTimes.length,
    };
  }

  clearTap() {
    this.tapBpm = 0;
    this.tapTimes = [];
  }

  getSnapshot(options = {}) {
    const {
      isPlaying = false,
      hasLiveFFT = false,
      vibeId = "synth",
      enabled = true,
      intensity = "balanced",
    } = options;

    let effectiveBpm = VIBE_DEFAULT_BPM[vibeId] || 118;
    let bpmSource = hasLiveFFT ? "detecting" : "est";
    if (this.tapBpm > 0) {
      effectiveBpm = this.tapBpm;
      bpmSource = "tap";
    } else if (hasLiveFFT && this.liveBpm > 0 && this.bpmConfidence >= 0.35) {
      effectiveBpm = this.liveBpm;
      bpmSource = "live";
    }

    const vibeGain = VIBE_BEAT_GAIN[vibeId] ?? 1.0;
    const intensityGain = BEAT_INTENSITY_GAIN[intensity] ?? 1.0;
    const beatWave = 0.5 + 0.5 * Math.cos(this.beatPhase * Math.PI * 2);

    return {
      enabled: Boolean(enabled),
      isBeat: false,
      isDownbeat: false,
      pulse: enabled && isPlaying ? clamp(this.beatPulse * vibeGain * intensityGain, 0, 1.35) : 0,
      rawPulse: this.beatPulse,
      downbeat: enabled && isPlaying ? clamp(this.downbeatPulse * vibeGain * intensityGain, 0, 1.35) : 0,
      phase: this.beatPhase,
      wave: beatWave,
      bpm: Math.round(effectiveBpm),
      bpmSource,
      confidence: this.bpmConfidence,
      beatCount: this.beatCount,
      synthBands: { bass: 0.11, mid: 0.09, high: 0.06 },
    };
  }

  _recordInterval(dtMs) {
    if (!Number.isFinite(dtMs)) return;

    // Handle a missed beat cleanly when we already have an established tempo
    let interval = dtMs;
    if (interval > 1100 && interval <= 2100 && this.liveBpm > 0) {
      const half = interval * 0.5;
      if (Math.abs(foldBpm(60000 / half) - this.liveBpm) < 10) {
        interval = half;
      }
    }

    if (interval < 260 || interval > 1250) return;

    this.ioiHistory.push(interval);
    if (this.ioiHistory.length > 18) {
      this.ioiHistory.shift();
    }

    if (this.ioiHistory.length < 3) return;

    const len = this.ioiHistory.length;
    const candidates = this.ioiHistory.map((dt, idx) => ({
      bpm: foldBpm(60000 / dt),
      weight: 0.55 + 0.45 * ((idx + 1) / len),
    }));

    let bestClusterSum = 0;
    let bestClusterMean = 0;
    let totalWeight = 0;

    for (let i = 0; i < candidates.length; i++) {
      totalWeight += candidates[i].weight;
      const center = candidates[i].bpm;
      let sumW = 0;
      let weightedSum = 0;

      for (let j = 0; j < candidates.length; j++) {
        const diffRatio = Math.abs(candidates[j].bpm - center) / center;
        if (diffRatio <= 0.045) {
          sumW += candidates[j].weight;
          weightedSum += candidates[j].bpm * candidates[j].weight;
        }
      }

      if (sumW > bestClusterSum) {
        bestClusterSum = sumW;
        bestClusterMean = weightedSum / sumW;
      }
    }

    if (bestClusterMean <= 0) return;

    const nextConfidence =
      this.ioiHistory.length >= 4
        ? clamp(bestClusterSum / Math.max(3.2, totalWeight * 0.72), 0, 1)
        : clamp(bestClusterSum / Math.max(3.0, totalWeight), 0, 0.45);

    const roundedCandidate = clamp(Math.round(bestClusterMean), 60, 185);

    // Hysteresis prevents jarring jumps once tempo is confidently locked
    if (this.liveBpm > 0 && this.bpmConfidence >= 0.55) {
      const diff = Math.abs(roundedCandidate - this.liveBpm) / this.liveBpm;
      if (diff <= 0.07) {
        this.liveBpm = Math.round(this.liveBpm * 0.65 + roundedCandidate * 0.35);
      } else if (nextConfidence > this.bpmConfidence + 0.12 && bestClusterSum >= 4.0) {
        this.liveBpm = roundedCandidate;
      }
    } else {
      this.liveBpm = roundedCandidate;
    }

    this.bpmConfidence = nextConfidence;
  }

  _analyzeSpectrum(freqData, nowMs) {
    const binCount = freqData.length;
    if (!this.prevSpectrum || this.prevSpectrum.length !== binCount) {
      this.prevSpectrum = new Float32Array(binCount);
    }

    const kickEnd = binCount >= 200
      ? 4
      : Math.max(2, Math.round(binCount * 0.032));
    const bodyEnd = binCount >= 200
      ? 24
      : Math.max(kickEnd + 4, Math.round(binCount * 0.22));

    let kickWeighted = 0;
    let kickWeightTotal = 0;
    for (let i = 0; i < kickEnd; i++) {
      const w = i < 2 ? 1.35 : 0.9;
      kickWeighted += (freqData[i] / 255) * w;
      kickWeightTotal += w;
    }
    const kickEnergy = kickWeighted / (kickWeightTotal || 1);

    let fluxSum = 0;
    for (let i = 0; i < bodyEnd; i++) {
      const curr = freqData[i] / 255;
      const diff = curr - this.prevSpectrum[i];
      if (diff > 0) fluxSum += diff;
      this.prevSpectrum[i] = curr;
    }
    const spectralFlux = fluxSum / (bodyEnd || 1);
    const kickRise = Math.max(0, kickEnergy - this.prevKickEnergy);

    const onsetSignal = kickEnergy * 0.45 + kickRise * 1.7 + spectralFlux * 1.2;

    this.kickHistory.push(kickEnergy);
    this.onsetHistory.push(onsetSignal);
    if (this.kickHistory.length > this.historySize) this.kickHistory.shift();
    if (this.onsetHistory.length > this.historySize) this.onsetHistory.shift();

    const len = this.onsetHistory.length;
    let avgKick = 0;
    let avgOnset = 0;
    for (let i = 0; i < len; i++) {
      avgKick += this.kickHistory[i];
      avgOnset += this.onsetHistory[i];
    }
    avgKick /= len || 1;
    avgOnset /= len || 1;

    let varOnset = 0;
    for (let i = 0; i < len; i++) {
      const d = this.onsetHistory[i] - avgOnset;
      varOnset += d * d;
    }
    const stdOnset = Math.sqrt(varOnset / (len || 1));

    const adaptiveThreshold = Math.max(
      avgOnset * 1.32,
      avgOnset + Math.max(0.052, stdOnset * 1.1)
    );
    const hasSignal = kickEnergy > 0.085 || avgKick > 0.06 || avgOnset > 0.065;
    const isRisingEdge = onsetSignal > this.prevOnsetSignal * 0.92 || kickRise > 0.035;
    const cooldownOk = nowMs - this.lastOnsetMs >= this.minBeatMs;

    let isBeat = false;
    let strength = 0;

    if (
      hasSignal &&
      cooldownOk &&
      isRisingEdge &&
      len >= 6 &&
      onsetSignal > adaptiveThreshold &&
      (kickEnergy > avgKick * 1.04 || spectralFlux > 0.04)
    ) {
      isBeat = true;
      const ratio = onsetSignal / Math.max(0.04, adaptiveThreshold);
      strength = clamp((ratio - 1.0) * 1.35 + kickRise * 2.2, 0.45, 1.0);

      const dtMs = nowMs - this.lastOnsetMs;
      if (Number.isFinite(dtMs)) {
        this._recordInterval(dtMs);
      }
      this.lastOnsetMs = nowMs;
    }

    this.prevKickEnergy = kickEnergy;
    this.prevOnsetSignal = onsetSignal;

    return {
      isBeat,
      strength,
      hasSignal,
      avgKick,
    };
  }

  update(nowMs, freqData = null, options = {}) {
    const {
      isPlaying = false,
      hasLiveFFT = false,
      vibeId = "synth",
      enabled = true,
      intensity = "balanced",
    } = options;

    const dtSec = this.lastFrameMs === null ? 0.016 : clamp((nowMs - this.lastFrameMs) / 1000, 0, 0.05);
    this.lastFrameMs = nowMs;

    if (!isPlaying) {
      this.wasPlaying = false;
      this.beatPulse *= Math.exp(-dtSec * 8.0);
      this.downbeatPulse *= Math.exp(-dtSec * 6.0);
      if (this.beatPulse < 0.004) this.beatPulse = 0;
      if (this.downbeatPulse < 0.004) this.downbeatPulse = 0;

      const idleBpm = this.tapBpm > 0
        ? this.tapBpm
        : (this.liveBpm > 0 && this.bpmConfidence >= 0.35 ? this.liveBpm : (VIBE_DEFAULT_BPM[vibeId] || 118));

      return {
        enabled: Boolean(enabled),
        isBeat: false,
        isDownbeat: false,
        pulse: 0,
        rawPulse: this.beatPulse,
        downbeat: 0,
        phase: this.beatPhase,
        wave: 0.5 + 0.5 * Math.cos(this.beatPhase * Math.PI * 2),
        bpm: Math.round(idleBpm),
        bpmSource: this.tapBpm > 0 ? "tap" : (this.liveBpm > 0 ? "live" : "est"),
        confidence: this.bpmConfidence,
        beatCount: this.beatCount,
        synthBands: { bass: 0.11, mid: 0.09, high: 0.06 },
      };
    }

    const justStarted = !this.wasPlaying;
    this.wasPlaying = true;

    let fftAnalysis = { isBeat: false, strength: 0, hasSignal: false, avgKick: 0 };
    if (hasLiveFFT && freqData && freqData.length >= 16) {
      fftAnalysis = this._analyzeSpectrum(freqData, nowMs);
    }

    let effectiveBpm = VIBE_DEFAULT_BPM[vibeId] || 118;
    let bpmSource = hasLiveFFT ? "detecting" : "est";
    if (this.tapBpm > 0) {
      effectiveBpm = this.tapBpm;
      bpmSource = "tap";
    } else if (hasLiveFFT && this.liveBpm > 0 && this.bpmConfidence >= 0.35) {
      effectiveBpm = this.liveBpm;
      bpmSource = "live";
    }

    const prevPhase = this.beatPhase;
    this.beatPhase = (this.beatPhase + (dtSec * effectiveBpm) / 60) % 1.0;
    const clockWrapped = !justStarted && this.beatPhase < prevPhase;

    let beatImpulse = 0;
    let downbeatImpulse = 0;
    let isBeat = false;
    let isDownbeat = false;

    if (hasLiveFFT) {
      if (fftAnalysis.isBeat) {
        isBeat = true;
        beatImpulse = clamp(0.55 + fftAnalysis.strength * 0.45, 0.55, 1.0);
        this.beatCount += 1;

        if (this.tapBpm === 0) {
          const phaseErr = this.beatPhase > 0.5 ? this.beatPhase - 1.0 : this.beatPhase;
          if (Math.abs(phaseErr) > 0.18) {
            this.beatPhase = 0;
          } else {
            this.beatPhase = (this.beatPhase - phaseErr * 0.55 + 1.0) % 1.0;
          }
        }

        if (this.beatCount % 4 === 0 || fftAnalysis.strength >= 0.85) {
          isDownbeat = true;
          downbeatImpulse = clamp(0.65 + fftAnalysis.strength * 0.35, 0.65, 1.0);
        }
        this.lastClockBeatMs = nowMs;
      } else if (
        clockWrapped &&
        fftAnalysis.hasSignal &&
        (this.tapBpm > 0 || this.bpmConfidence >= 0.6) &&
        nowMs - this.lastOnsetMs > (60000 / effectiveBpm) * 0.78
      ) {
        // Gentle PLL reinforcement between kicks during steady grooves
        isBeat = true;
        beatImpulse = 0.42;
        this.beatCount += 1;
        if (this.beatCount % 4 === 0) {
          isDownbeat = true;
          downbeatImpulse = 0.52;
        }
        this.lastClockBeatMs = nowMs;
      }
    } else if (justStarted || clockWrapped) {
      isBeat = true;
      beatImpulse = 0.88;
      this.beatCount += 1;
      if (this.beatCount % 4 === 0) {
        isDownbeat = true;
        downbeatImpulse = 0.96;
      }
      this.lastClockBeatMs = nowMs;
    }

    this.beatPulse = Math.max(beatImpulse, this.beatPulse * Math.exp(-dtSec * 8.5));
    this.downbeatPulse = Math.max(downbeatImpulse, this.downbeatPulse * Math.exp(-dtSec * 4.8));

    const beatWave = 0.5 + 0.5 * Math.cos(this.beatPhase * Math.PI * 2);
    const vibeGain = VIBE_BEAT_GAIN[vibeId] ?? 1.0;
    const intensityGain = BEAT_INTENSITY_GAIN[intensity] ?? 1.0;

    const scaledPulse = enabled
      ? clamp(this.beatPulse * vibeGain * intensityGain, 0, 1.35)
      : 0;
    const scaledDownbeat = enabled
      ? clamp(this.downbeatPulse * vibeGain * intensityGain, 0, 1.35)
      : 0;

    // Musical BPM-locked synthetic frequency bands for YouTube Embed fallback
    const synthBass = clamp(0.16 + this.beatPulse * 0.58 + beatWave * 0.14, 0, 1);
    const synthMid = clamp(0.18 + this.beatPulse * 0.28 + 0.22 * Math.abs(Math.sin(this.beatPhase * Math.PI * 2)), 0, 1);
    const synthHigh = clamp(0.14 + Math.pow(Math.sin(this.beatPhase * Math.PI * 2), 2) * 0.34 + this.downbeatPulse * 0.18, 0, 1);

    return {
      enabled: Boolean(enabled),
      isBeat,
      isDownbeat,
      pulse: scaledPulse,
      rawPulse: this.beatPulse,
      downbeat: scaledDownbeat,
      phase: this.beatPhase,
      wave: beatWave,
      bpm: Math.round(effectiveBpm),
      bpmSource,
      confidence: this.bpmConfidence,
      beatCount: this.beatCount,
      synthBands: { bass: synthBass, mid: synthMid, high: synthHigh },
    };
  }
}
