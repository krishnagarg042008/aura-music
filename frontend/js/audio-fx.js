/**
 * AURA Sound Modes DSP Engine — real-time WebAudio effects for
 * Slowed + Reverb, Lo-Fi, Vaporwave, Sped Up / Nightcore, 8D Spatial Orbit,
 * Underwater low-pass, plus custom Speed, Reverb, Warmth, Vinyl Crackle, and Pitch-Lock.
 */

export const SOUND_MODE_PRESETS = {
  normal: {
    id: "normal",
    label: "Normal",
    speed: 1.0,
    reverb: 0,
    warmth: 0,
    crackle: false,
    spatial8D: false,
    pitchLock: false,
  },
  slowed: {
    id: "slowed",
    label: "Slowed + Reverb",
    speed: 0.84,
    reverb: 0.58,
    warmth: 0.24,
    crackle: false,
    spatial8D: false,
    pitchLock: false,
  },
  lofi: {
    id: "lofi",
    label: "Lo-Fi",
    speed: 0.94,
    reverb: 0.30,
    warmth: 0.68,
    crackle: true,
    spatial8D: false,
    pitchLock: false,
  },
  vaporwave: {
    id: "vaporwave",
    label: "Vaporwave",
    speed: 0.76,
    reverb: 0.74,
    warmth: 0.46,
    crackle: true,
    spatial8D: false,
    pitchLock: false,
  },
  nightcore: {
    id: "nightcore",
    label: "Sped Up",
    speed: 1.22,
    reverb: 0.14,
    warmth: 0,
    crackle: false,
    spatial8D: false,
    pitchLock: false,
  },
  "8d": {
    id: "8d",
    label: "8D Audio",
    speed: 1.0,
    reverb: 0.44,
    warmth: 0.10,
    crackle: false,
    spatial8D: true,
    pitchLock: false,
  },
  underwater: {
    id: "underwater",
    label: "Underwater",
    speed: 0.90,
    reverb: 0.50,
    warmth: 0.92,
    crackle: false,
    spatial8D: false,
    pitchLock: false,
  },
};

export const DEFAULT_SOUND_FX = { ...SOUND_MODE_PRESETS.normal };

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function normalizeSoundFx(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const preset = typeof src.preset === "string" ? src.preset : "normal";
  return {
    preset,
    speed: clamp(Number.isFinite(Number(src.speed)) ? Number(src.speed) : 1.0, 0.65, 1.35),
    reverb: clamp(Number.isFinite(Number(src.reverb)) ? Number(src.reverb) : 0, 0, 1),
    warmth: clamp(Number.isFinite(Number(src.warmth)) ? Number(src.warmth) : 0, 0, 1),
    crackle: Boolean(src.crackle),
    spatial8D: Boolean(src.spatial8D),
    pitchLock: Boolean(src.pitchLock),
  };
}

export function detectSoundPresetMatch(fx) {
  const norm = normalizeSoundFx(fx);
  for (const preset of Object.values(SOUND_MODE_PRESETS)) {
    if (
      Math.abs(norm.speed - preset.speed) < 0.008 &&
      Math.abs(norm.reverb - preset.reverb) < 0.015 &&
      Math.abs(norm.warmth - preset.warmth) < 0.015 &&
      norm.crackle === preset.crackle &&
      norm.spatial8D === preset.spatial8D &&
      norm.pitchLock === preset.pitchLock
    ) {
      return preset.id;
    }
  }
  return "custom";
}

export function computeWarmthParams(warmth) {
  const w = clamp(Number(warmth) || 0, 0, 1);
  // Logarithmic sweep from 20 kHz (bypass) down to 580 Hz (underwater)
  const cutoffHz = Math.round(20000 * Math.pow(580 / 20000, w));
  const resonanceQ = Number((0.707 + w * 0.72).toFixed(3));
  const midWarmthDb = Number((w * 3.4).toFixed(2));
  const drive = Number((w * 2.1).toFixed(3));
  return { cutoffHz, resonanceQ, midWarmthDb, drive };
}

export function computeReverbMix(reverb) {
  const r = clamp(Number(reverb) || 0, 0, 1);
  return {
    dryGain: Number((1.0 - r * 0.28).toFixed(3)),
    wetGain: Number((r * 0.78).toFixed(3)),
  };
}

export function mapYoutubeRate(speed, availableRates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]) {
  const s = clamp(Number(speed) || 1.0, 0.25, 2.0);
  const rates = Array.isArray(availableRates) && availableRates.length ? availableRates : [0.75, 1, 1.25];
  let best = rates[0];
  let bestDist = Math.abs(s - best);
  for (let i = 1; i < rates.length; i++) {
    const dist = Math.abs(s - rates[i]);
    if (dist < bestDist) {
      best = rates[i];
      bestDist = dist;
    }
  }
  return best;
}

export function buildTapeDriveCurve(drive, samples = 1024) {
  const k = Math.max(0.05, Number(drive) || 0);
  const curve = new Float32Array(samples);
  const norm = Math.tanh(k) || 1;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = Math.tanh(x * k) / norm;
  }
  return curve;
}

export function applyDeckSpeedAndPitch(deck, speed, pitchLock) {
  if (!deck) return;
  const targetRate = clamp(Number(speed) || 1.0, 0.65, 1.35);
  const preserve = Boolean(pitchLock);
  try {
    deck.defaultPlaybackRate = targetRate;
    deck.playbackRate = targetRate;
    if ("preservesPitch" in deck) deck.preservesPitch = preserve;
    if ("webkitPreservesPitch" in deck) deck.webkitPreservesPitch = preserve;
    if ("mozPreservesPitch" in deck) deck.mozPreservesPitch = preserve;
  } catch {}
}

function createStereoImpulseBuffer(audioCtx, durationSec = 2.6, decay = 2.9) {
  const rate = audioCtx.sampleRate || 44100;
  const length = Math.max(1, Math.floor(rate * durationSec));
  const impulse = audioCtx.createBuffer(2, length, rate);
  const fadeSamples = Math.max(1, Math.floor(rate * 0.016)); // 16ms soft bloom attack

  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const white = Math.random() * 2 - 1;
      // Gentle pink-like damping prevents metallic fizz in the reverb tail
      lp = lp * 0.68 + white * 0.32;
      const attack = i < fadeSamples ? i / fadeSamples : 1.0;
      const env = Math.pow(1 - t, decay) * attack;
      data[i] = lp * env;
    }
  }
  return impulse;
}

function createVinylCrackleBuffer(audioCtx, durationSec = 4.0) {
  const rate = audioCtx.sampleRate || 44100;
  const length = Math.max(1, Math.floor(rate * durationSec));
  const buf = audioCtx.createBuffer(2, length, rate);

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let pink = 0;
    let popDecay = 0;
    let popSign = 1;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      pink = pink * 0.94 + white * 0.06;
      if (Math.random() < 0.00055) {
        popDecay = 0.28 + Math.random() * 0.45;
        popSign = Math.random() < 0.5 ? 1 : -1;
      } else {
        popDecay *= 0.88;
      }
      data[i] = pink * 0.24 + popDecay * popSign * 0.45;
    }
  }
  return buf;
}

/**
 * Create the WebAudio DSP rack inserted between EQ and Compressor.
 */
export function createAudioFxRack(audioCtx, inputNode, outputNode) {
  const toneFilter = audioCtx.createBiquadFilter();
  toneFilter.type = "lowpass";
  toneFilter.frequency.value = 20000;
  toneFilter.Q.value = 0.707;

  const warmthFilter = audioCtx.createBiquadFilter();
  warmthFilter.type = "peaking";
  warmthFilter.frequency.value = 240;
  warmthFilter.Q.value = 0.9;
  warmthFilter.gain.value = 0;

  const tapeShaper = audioCtx.createWaveShaper();
  tapeShaper.oversample = "2x";
  tapeShaper.curve = null;

  const dryGain = audioCtx.createGain();
  dryGain.gain.value = 1.0;

  const reverbConvolver = audioCtx.createConvolver();
  reverbConvolver.buffer = createStereoImpulseBuffer(audioCtx);

  const reverbDamp = audioCtx.createBiquadFilter();
  reverbDamp.type = "lowpass";
  reverbDamp.frequency.value = 4800;
  reverbDamp.Q.value = 0.7;

  const reverbWetGain = audioCtx.createGain();
  reverbWetGain.gain.value = 0.0;

  const mixBus = audioCtx.createGain();
  mixBus.gain.value = 1.0;

  // 8D Spatial Orbit Panner
  const pannerNode = typeof audioCtx.createStereoPanner === "function"
    ? audioCtx.createStereoPanner()
    : audioCtx.createGain();
  const lfoOsc = audioCtx.createOscillator();
  lfoOsc.type = "sine";
  lfoOsc.frequency.value = 0.14;
  const lfoDepth = audioCtx.createGain();
  lfoDepth.gain.value = 0.0;

  if (pannerNode.pan) {
    lfoOsc.connect(lfoDepth);
    lfoDepth.connect(pannerNode.pan);
  }
  lfoOsc.start();

  // Subtle Vinyl Crackle loop (only audible when playing + crackle enabled)
  const vinylSource = audioCtx.createBufferSource();
  vinylSource.buffer = createVinylCrackleBuffer(audioCtx);
  vinylSource.loop = true;

  const vinylHp = audioCtx.createBiquadFilter();
  vinylHp.type = "highpass";
  vinylHp.frequency.value = 340;

  const vinylBp = audioCtx.createBiquadFilter();
  vinylBp.type = "bandpass";
  vinylBp.frequency.value = 1900;
  vinylBp.Q.value = 0.75;

  const vinylGain = audioCtx.createGain();
  vinylGain.gain.value = 0.0;

  vinylSource.connect(vinylHp);
  vinylHp.connect(vinylBp);
  vinylBp.connect(vinylGain);
  vinylGain.connect(outputNode);
  vinylSource.start();

  // Connect main signal chain
  inputNode.connect(toneFilter);
  toneFilter.connect(warmthFilter);
  warmthFilter.connect(tapeShaper);

  tapeShaper.connect(dryGain);
  dryGain.connect(mixBus);

  tapeShaper.connect(reverbConvolver);
  reverbConvolver.connect(reverbDamp);
  reverbDamp.connect(reverbWetGain);
  reverbWetGain.connect(mixBus);

  mixBus.connect(pannerNode);
  pannerNode.connect(outputNode);

  let currentFx = { ...DEFAULT_SOUND_FX };
  let currentlyPlaying = false;

  function syncVinylGain(now) {
    const wantVinyl = currentlyPlaying && currentFx.crackle ? 0.036 : 0.0;
    vinylGain.gain.setTargetAtTime(wantVinyl, now, 0.08);
  }

  function applySettings(fx, isPlaying = currentlyPlaying) {
    currentFx = normalizeSoundFx(fx);
    currentlyPlaying = Boolean(isPlaying);
    const now = audioCtx.currentTime;

    const { cutoffHz, resonanceQ, midWarmthDb, drive } = computeWarmthParams(currentFx.warmth);
    toneFilter.frequency.setTargetAtTime(cutoffHz, now, 0.04);
    toneFilter.Q.setTargetAtTime(resonanceQ, now, 0.04);
    warmthFilter.gain.setTargetAtTime(midWarmthDb, now, 0.04);
    tapeShaper.curve = currentFx.warmth > 0.03 ? buildTapeDriveCurve(drive) : null;

    const { dryGain: dryVal, wetGain: wetVal } = computeReverbMix(currentFx.reverb);
    dryGain.gain.setTargetAtTime(dryVal, now, 0.05);
    reverbWetGain.gain.setTargetAtTime(wetVal, now, 0.05);

    if (pannerNode.pan) {
      lfoDepth.gain.setTargetAtTime(currentFx.spatial8D ? 0.85 : 0.0, now, 0.08);
      if (!currentFx.spatial8D) {
        pannerNode.pan.setTargetAtTime(0.0, now, 0.08);
      }
    }

    syncVinylGain(now);
  }

  function setPlaying(isPlaying) {
    currentlyPlaying = Boolean(isPlaying);
    syncVinylGain(audioCtx.currentTime);
  }

  return {
    applySettings,
    setPlaying,
  };
}
