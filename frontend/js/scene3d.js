import * as THREE from "three";

const BACKDROP_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BACKDROP_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uMouse;
  uniform vec2 uClick;
  uniform float uShock;
  uniform float uBass;
  uniform float uMid;
  uniform float uHigh;
  uniform float uBeat;
  uniform float uDownbeat;
  uniform float uBeatPhase;
  uniform float uSpeed;
  uniform float uTurbulence;
  uniform float uIntensity;
  uniform float uAspect;
  uniform float uAnimeRay;
  uniform float uMangaTone;
  uniform float uPastelMode;
  uniform float uPastelMix;
  uniform float uLightGain;
  uniform vec3 uColorBase;
  uniform vec3 uColorA;
  uniform vec3 uColorB;

  // Trig-free hash avoids sin() precision block artifacts on Windows/ANGLE GPUs
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  vec2 hashGrad(vec2 p) {
    float a = hash12(p) * 6.2831853;
    return vec2(cos(a), sin(a));
  }

  // Smooth C2 quintic gradient noise (eliminates axis-aligned square grid bumps)
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

    float n00 = dot(hashGrad(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
    float n10 = dot(hashGrad(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
    float n01 = dot(hashGrad(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
    float n11 = dot(hashGrad(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));

    float res = mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
    return clamp(0.5 + 0.5 * res, 0.0, 1.0);
  }

  // Rotated multi-octave FBM prevents horizontal/vertical lattice alignment
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
    for (int i = 0; i < 4; i++) {
      v += a * noise(p);
      p = rot * p * 2.02 + vec2(13.7, 29.3);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv;
    vec2 aspScale = vec2(max(0.5, uAspect), 1.0);
    float t = uTime * 0.2 * uSpeed;
    float inten = clamp(uIntensity, 0.2, 1.8);

    // Aspect-correct interactive click ripple
    vec2 deltaClick = (uv - uClick) * aspScale;
    float dClick = length(deltaClick);
    float ripple = sin(dClick * 24.0 - uShock * 18.0) * exp(-dClick * 4.2) * exp(-uShock * 2.5);
    uv += normalize(deltaClick + vec2(0.0001)) * ripple * 0.028 * inten;

    // Smooth aspect-balanced liquid domain flow
    vec2 flowUv = (uv - 0.5) * aspScale + 0.5;
    float turb = clamp(uTurbulence, 0.3, 2.5);
    vec2 q = vec2(
      fbm(flowUv * (1.45 + turb * 0.18) + vec2(t, -t * 0.6) + uMouse * 0.25),
      fbm(flowUv * (1.45 + turb * 0.18) + vec2(-t * 0.5, t * 0.8))
    );
    float f = fbm(flowUv * 1.9 + q * (1.35 + turb * 0.24 + (uBass * 1.05 + uBeat * 0.42) * inten));

    vec3 col = mix(uColorBase, uColorA, smoothstep(0.18, 0.82, f));
    col = mix(col, uColorB, smoothstep(0.45, 0.94, length(q) * 0.72 + (uBass * 0.22 + uMid * 0.16 + uBeat * 0.14) * inten));

    // Vocal/mid aurora ribbon across the upper atmosphere
    float ribbonWave = sin(uv.x * 4.2 + t * 1.5 + q.x * 2.8) * 0.14 + 0.60;
    float auroraBand = exp(-abs(uv.y - ribbonWave) * 7.5) * (0.13 + uMid * 0.28 + uBeat * 0.14) * inten;
    col += mix(uColorA, uColorB, uv.x) * auroraBand;

    // Anime Pastel Sky Presets (1=Daydream Clouds, 2=Peach Dusk, 3=Ghibli Breeze, 4=Night Lavender)
    if (uPastelMix > 0.01) {
      float drift = uTime * 0.032 * max(0.35, uSpeed);
      vec2 cloudUv = vec2(flowUv.x * 1.25 - drift, uv.y * 2.1 + q.y * 0.12);
      float cloudBase = fbm(cloudUv + vec2(0.0, uMid * 0.06));
      float cloudDetail = fbm(cloudUv * 2.3 + vec2(4.2, -drift * 1.4));
      float cloudMask = smoothstep(0.42, 0.72, cloudBase * 0.72 + cloudDetail * 0.28 + (0.08 - uv.y * 0.18));
      float cloudLight = smoothstep(0.46, 0.80, cloudDetail + uv.y * 0.14 + uMid * 0.08);
      vec3 pastelSky = col;

      if (uPastelMode < 1.5) {
        // 1. Daydream: Cotton-candy baby blue sky -> periwinkle -> blush pink horizon + cel clouds
        vec3 skyTop = vec3(0.54, 0.77, 0.99);
        vec3 skyMid = vec3(0.76, 0.71, 0.98);
        vec3 skyHorizon = vec3(0.99, 0.80, 0.90);
        vec3 baseSky = mix(skyHorizon, mix(skyMid, skyTop, smoothstep(0.38, 0.95, uv.y)), smoothstep(0.0, 0.62, uv.y));
        vec3 cloudShadow = vec3(0.79, 0.74, 0.96);
        vec3 cloudHighlight = vec3(1.0, 0.96, 0.99);
        vec3 celCloud = mix(cloudShadow, cloudHighlight, cloudLight);
        pastelSky = mix(baseSky, celCloud, cloudMask * 0.85);
      } else if (uPastelMode < 2.5) {
        // 2. Peach Dusk: Powder blue -> soft lilac -> warm apricot horizon + jet contrails
        vec3 zenith = vec3(0.55, 0.76, 0.98);
        vec3 duskMid = vec3(0.84, 0.73, 0.96);
        vec3 peachGlow = vec3(1.0, 0.83, 0.70);
        vec3 coralRim = vec3(0.99, 0.68, 0.76);
        vec3 sunset = mix(peachGlow, mix(coralRim, mix(duskMid, zenith, smoothstep(0.50, 0.98, uv.y)), smoothstep(0.24, 0.58, uv.y)), smoothstep(0.0, 0.34, uv.y));
        vec3 warmCloud = mix(vec3(0.95, 0.74, 0.84), vec3(1.0, 0.93, 0.86), cloudLight);
        pastelSky = mix(sunset, warmCloud, cloudMask * 0.68);
        float contrail = exp(-abs((uv.y - 0.66) - uv.x * 0.22 + sin(uv.x * 3.0) * 0.015) * 75.0) * smoothstep(0.15, 0.85, uv.x);
        float contrail2 = exp(-abs((uv.y - 0.72) - uv.x * 0.21) * 95.0) * smoothstep(0.25, 0.92, uv.x) * 0.65;
        pastelSky += vec3(1.0, 0.95, 0.96) * (contrail + contrail2) * 0.42;
      } else if (uPastelMode < 3.5) {
        // 3. Ghibli Breeze: Warm cream sunlight -> powder cyan -> soft sage-mint meadow sky
        vec3 sunTop = vec3(0.99, 0.96, 0.82);
        vec3 airBlue = vec3(0.71, 0.90, 0.98);
        vec3 mintHorizon = vec3(0.66, 0.94, 0.82);
        vec3 meadowSky = mix(mintHorizon, mix(airBlue, sunTop, smoothstep(0.42, 0.96, uv.y + uv.x * 0.14)), smoothstep(0.04, 0.48, uv.y));
        vec3 ghibliCloud = mix(vec3(0.76, 0.91, 0.95), vec3(1.0, 0.99, 0.94), cloudLight);
        pastelSky = mix(meadowSky, ghibliCloud, cloudMask * 0.82);
      } else {
        // 4. Night Lavender: Cozy plum edges opening into luminous lilac, rose & ice-mint aura
        vec3 deepPlum = vec3(0.15, 0.09, 0.25);
        vec3 lilacMist = vec3(0.68, 0.52, 0.92);
        vec3 roseVapor = vec3(0.93, 0.58, 0.79);
        vec3 iceMint = vec3(0.55, 0.90, 0.95);
        vec3 vapor = mix(deepPlum, lilacMist, smoothstep(0.18, 0.85, f));
        vapor = mix(vapor, roseVapor, smoothstep(0.42, 0.92, cloudMask + uBass * 0.18));
        vapor += iceMint * exp(-abs(uv.y - ribbonWave) * 6.5) * (0.16 + uMid * 0.26) * inten;
        pastelSky = vapor;
      }

      col = mix(col, pastelSky, uPastelMix);
    }

    // Subtle treble sparkle & edge bloom
    float shimmer = pow(noise(flowUv * 12.0 + vec2(t * 1.6, -t * 1.2)), 4.0) * (uHigh + uBeat * 0.18) * 0.22 * inten;
    col += uColorB * shimmer;

    // Aspect-correct soft cursor glow + radial bass breath
    float cursorDist = length((vUv - (uMouse * 0.5 + 0.5)) * aspScale);
    float cursorGlow = exp(-cursorDist * 3.4) * (0.14 + uBass * 0.22 + uBeat * 0.12) * inten;
    col += mix(uColorB, vec3(1.0, 0.86, 0.94), uPastelMix * 0.6) * cursorGlow;

    // Beat-synced radial bloom + subtle downbeat halo pulse
    vec2 centeredBeat = (vUv - 0.5) * aspScale;
    float beatRad = length(centeredBeat);
    float downbeatWave = exp(-abs(beatRad - uBeatPhase * 0.85) * 9.5) * uDownbeat * 0.11 * inten;
    float beatAura = smoothstep(0.85, 0.12, beatRad) * uBeat * 0.085 * inten;
    float beatDarkScale = mix(1.0, 0.38, uPastelMix);
    col += mix(uColorA, uColorB, 0.5 + 0.5 * sin(uTime * 0.5)) * (downbeatWave + beatAura) * beatDarkScale;

    // Anime Makoto Shinkai twilight diagonal sunbeams
    if (uAnimeRay > 0.01) {
      float rayAxis = (uv.x * 0.72 + uv.y * 0.95) * 6.5 - t * 0.42;
      float rays = pow(0.5 + 0.5 * sin(rayAxis), 4.0) * smoothstep(0.12, 0.95, uv.y) * uAnimeRay;
      col += mix(vec3(1.0, 0.56, 0.80), vec3(0.45, 0.84, 1.0), uv.x) * rays * (0.14 + uMid * 0.18 + uBeat * 0.12) * inten;
    }

    // Manga panel edge speed-lines reactive to bass hits
    if (uMangaTone > 0.01) {
      vec2 centered = (vUv - 0.5) * aspScale;
      float ang = atan(centered.y, centered.x);
      float rad = length(centered);
      float streak = pow(0.5 + 0.5 * sin(ang * 44.0 + floor(uTime * 10.0) * 0.35), 8.0);
      col += vec3(0.88, 0.95, 1.0) * streak * smoothstep(0.26, 0.68, rad) * (0.04 + uBass * 0.14 + uBeat * 0.14) * uMangaTone * inten;
    }

    // Triangular screen-space dithering eliminates 8-bit contour banding in dark gradients
    vec3 finalCol = clamp(col * uLightGain, 0.0, 1.0);
    float dither = (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + vec2(37.0, 19.0)) - 1.0) * (1.25 / 255.0);
    gl_FragColor = vec4(clamp(finalCol + dither, 0.0, 1.0), 1.0);
  }
`;

const PARTICLE_VERT = `
  attribute vec3 aSeed;
  uniform float uTime;
  uniform float uBeatTime;
  uniform float uSpeed;
  uniform float uBass;
  uniform float uMid;
  uniform float uHigh;
  uniform float uBeat;
  uniform float uDownbeat;
  uniform float uTurbulence;
  uniform float uMode;
  uniform float uIntensity;
  uniform float uPixelRatio;
  varying float vSeed;
  varying float vAlpha;
  varying float vHigh;

  void main() {
    vec3 p = position;
    float s1 = aSeed.x;
    float s2 = aSeed.y;
    float s3 = aSeed.z;
    float boost = 1.0 + (uBass * 2.2 + uBeat * 0.9) * clamp(uIntensity, 0.3, 1.6);
    float bt = mix(uTime, uBeatTime, 0.65);
    float t = bt * (0.55 + uSpeed * 0.45);

    if (uMode > 2.5 && uMode < 3.5) {
      // Rain: downward diagonal streaks
      float spanY = 14.0;
      p.y = 7.0 - mod(7.0 - p.y + bt * (4.2 + s1 * 3.1), spanY);
      p.x = mod(p.x - bt * 0.55 + 11.0, 22.0) - 11.0;
    } else if (uMode > 3.5 && uMode < 4.5) {
      // Embers: turbulent rising sparks
      float spanY = 14.0;
      p.y = mod(p.y + 7.0 + bt * (1.6 + s1 * 2.1) * boost, spanY) - 7.0;
      p.x += sin(bt * 2.4 + s2 * 18.0) * 0.65 * uTurbulence;
    } else if (uMode > 1.5 && uMode < 2.5) {
      // Warp: stars flying forward toward camera
      float spanZ = 17.0;
      p.z = mod(p.z + 15.0 + bt * (2.6 + s1 * 3.0) * boost, spanZ) - 15.0;
    } else if (uMode > 0.5 && uMode < 1.5) {
      // Burst: radial pulse expansion
      float cycle = fract(s3 + bt * (0.20 + uBass * 0.38 + uBeat * 0.24) * max(0.5, uSpeed));
      float angle = s2 * 6.2831853;
      float radius = 0.8 + cycle * (10.5 + uBeat * 1.4);
      p.x = cos(angle) * radius * 1.35;
      p.y = sin(angle) * radius * 0.9;
      p.z = -3.0 - (1.0 - cycle) * 8.0;
    } else if (uMode > 5.5 && uMode < 6.5) {
      // Diya (Spiritual): slow gently rising sacred warm lights
      float spanY = 14.0;
      p.y = mod(p.y + 7.0 + bt * (0.48 + s1 * 0.55) * (1.0 + uMid * 0.8), spanY) - 7.0;
      p.x += sin(bt * 0.7 + s2 * 14.0) * 0.38;
    } else if (uMode > 7.5) {
      // Sakura (Anime): cherry blossom petals drifting & fluttering in diagonal breeze
      float spanY = 14.0;
      float fallRate = 1.05 + s1 * 1.1 + uBass * 0.45 + uBeat * 0.35;
      p.y = 7.0 - mod(7.0 - p.y + bt * fallRate, spanY);
      float breeze = sin(bt * 1.25 + s2 * 16.0 + p.y * 0.45) * (0.85 + uBeat * 0.25);
      p.x = mod(p.x - bt * (0.52 + s3 * 0.35) + breeze + 11.0, 22.0) - 11.0;
      p.z += cos(bt * 1.05 + s1 * 12.0) * 0.35;
    } else if (uMode > 6.5) {
      // Astral (Cosmic): slow celestial orbital field
      float drift = t * 0.28 + s2 * 6.28318;
      p.x += cos(drift) * 0.75;
      p.y += sin(drift * 1.15 + s1 * 9.0) * 0.55;
      p.z += sin(drift * 0.6 + s3 * 6.0) * 0.4;
    } else if (uMode > 4.5) {
      // Stardust / Bokeh petals (Romance): drifting warm bloom orbs
      float drift = t * 0.4 + s2 * 6.28318;
      p.x += cos(drift) * 0.65;
      p.y += sin(drift * 1.3 + s1 * 10.0) * 0.55;
    } else {
      // Float (Chill): gentle ambient aqua suspension
      p.y += sin(bt * 0.55 + s1 * 20.0) * 0.55;
      p.x += cos(bt * 0.35 + s2 * 15.0) * 0.45;
    }

    p.xy *= 1.0 + (uBeat * 0.055 + uDownbeat * 0.03) * clamp(uIntensity, 0.3, 1.5);

    vSeed = s1;
    vHigh = uHigh;
    vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPos;

    float depthFade = clamp(1.0 - (-mvPos.z / 20.0), 0.15, 1.0);
    vAlpha = depthFade * (0.35 + 0.35 * sin(uTime * 1.4 + s2 * 12.0) + (uBass * 0.25 + uMid * 0.12 + uBeat * 0.22)) * clamp(uIntensity, 0.35, 1.4);

    float sizeScale = (uMode > 7.5 || (uMode > 2.5 && uMode < 3.5)) ? 26.0 : (uMode > 4.5 && uMode < 6.5 ? 24.0 : 18.0);
    float baseSize = (sizeScale + s1 * 16.0 + uBass * 13.0 + uBeat * 8.5) * uPixelRatio;
    gl_PointSize = clamp(baseSize / max(1.0, -mvPos.z), 2.0, 26.0);
  }
`;

const PARTICLE_FRAG = `
  precision mediump float;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uMode;
  uniform float uTime;
  uniform float uBrightMode;
  varying float vSeed;
  varying float vAlpha;
  varying float vHigh;

  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float shape = 0.0;

    if (uMode > 7.5) {
      // Anime Sakura: rotating notched cherry-blossom petal
      float ang = uTime * (0.9 + vSeed * 1.5) + vSeed * 6.28318;
      float c = cos(ang);
      float s = sin(ang);
      vec2 rp = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
      rp.x *= 1.35;
      rp.y = rp.y * 1.05 + 0.04;
      float notch = smoothstep(0.0, 0.22, rp.y) * max(0.0, 0.14 - abs(rp.x) * 0.75);
      float d = length(rp + vec2(0.0, notch)) + max(0.0, -rp.y) * 0.12;
      shape = smoothstep(0.36, 0.11, d) * 0.92;
    } else if (uMode > 2.5 && uMode < 3.5) {
      // Raindrop: slanted narrow streak
      vec2 rp = vec2(p.x * 0.96 - p.y * 0.26, p.x * 0.26 + p.y * 0.96);
      float sx = smoothstep(0.08, 0.01, abs(rp.x));
      float sy = smoothstep(0.48, 0.08, abs(rp.y));
      shape = sx * sy;
    } else if (uMode > 0.5 && uMode < 1.5) {
      // Hype Burst: energetic beat diamond flare
      float md = abs(p.x) + abs(p.y);
      shape = smoothstep(0.45, 0.04, md);
    } else if (uMode > 1.5 && uMode < 2.5 || uMode > 6.5) {
      // Synth Warp / Cosmic Astral: crisp 4-point star
      float twinkle = 0.72 + 0.28 * sin(uTime * 3.2 + vSeed * 40.0 + vHigh * 4.0);
      float rays = max(exp(-abs(p.x) * 14.0) * exp(-abs(p.y) * 4.2), exp(-abs(p.y) * 14.0) * exp(-abs(p.x) * 4.2));
      float core = smoothstep(0.28, 0.02, length(p));
      shape = clamp(rays * 0.9 + core * 0.8, 0.0, 1.0) * twinkle;
    } else if (uMode > 3.5 && uMode < 4.5) {
      // Rock Embers: bright flickering sparks
      float flicker = 0.55 + 0.45 * sin(uTime * 11.0 + vSeed * 55.0);
      shape = smoothstep(0.42, 0.04, length(p * vec2(1.25, 0.85))) * flicker;
    } else if (uMode > 5.5 && uMode < 6.5) {
      // Spiritual Diya: warm rising teardrop flame orb
      vec2 fp = vec2(p.x * (1.2 + p.y * 0.6), p.y + 0.06);
      float flame = smoothstep(0.42, 0.03, length(fp));
      float innerCore = smoothstep(0.2, 0.0, length(p - vec2(0.0, 0.05))) * 0.55;
      shape = clamp(flame + innerCore, 0.0, 1.0);
    } else if (uMode > 4.5) {
      // Romance: creamy ring bokeh
      float d = length(p);
      float disc = smoothstep(0.48, 0.16, d) * 0.55;
      float ring = smoothstep(0.14, 0.02, abs(d - 0.30)) * 0.65;
      shape = clamp(disc + ring, 0.0, 1.0);
    } else {
      // Chill: soft airy translucent bubbles
      float d = length(p);
      shape = smoothstep(0.48, 0.08, d) * 0.78;
    }

    if (shape < 0.02) discard;
    vec3 col = mix(uColorB, uColorA, vSeed * 0.55);
    if (uMode > 7.5) {
      vec3 darkSakura = mix(vec3(1.0, 0.72, 0.86), vec3(1.0, 0.92, 0.97), vSeed);
      vec3 brightSakura = mix(vec3(0.95, 0.34, 0.62), vec3(1.0, 0.66, 0.84), vSeed);
      col = mix(mix(col, darkSakura, 0.72), brightSakura, clamp(uBrightMode, 0.0, 1.0));
    } else if (uBrightMode > 0.05) {
      vec3 pastelAccent = mix(vec3(0.92, 0.42, 0.68), vec3(0.32, 0.64, 0.95), vSeed);
      col = mix(col, pastelAccent, 0.65 * clamp(uBrightMode, 0.0, 1.0));
    }
    gl_FragColor = vec4(col, shape * clamp(vAlpha, 0.0, 0.82));
  }
`;

const PARTICLE_MODE_INDEX = {
  float: 0.0,
  burst: 1.0,
  warp: 2.0,
  rain: 3.0,
  embers: 4.0,
  stardust: 5.0,
  diya: 6.0,
  astral: 7.0,
  sakura: 8.0,
};

const INTENSITY_MAP = {
  minimal: 0.38,
  balanced: 1.0,
  vivid: 1.5,
};

const PASTEL_MODE_INDEX = {
  off: 0.0,
  daydream: 1.0,
  peach: 2.0,
  ghibli: 3.0,
  lavender: 4.0,
};

export class VibeScene3D {
  constructor(canvas) {
    this.canvas = canvas;
    const isMobile = window.innerWidth < 768;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !isMobile,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.position.set(0, 0, 7.2);

    this.clock = new THREE.Clock();
    this.mouse = new THREE.Vector2(0, 0);
    this.targetMouse = new THREE.Vector2(0, 0);
    this.clickUV = new THREE.Vector2(0.5, 0.5);
    this.shockTime = 10.0;
    this.isDisposed = false;
    this.isHidden = document.hidden;
    this.rafId = null;

    this.targetColors = {
      base: new THREE.Color("#0f0728"),
      a: new THREE.Color("#ec4899"),
      b: new THREE.Color("#06b6d4"),
    };

    this.vibe = {
      id: "synth",
      particle_mode: "warp",
      speed: 1.15,
      turbulence: 1.1,
    };

    this.visualIntensity = 1.0;
    this.particlesEnabled = true;
    this.themeSkin = "default";
    this.pastelBg = "off";
    this.targetAnimeRay = 0.0;
    this.targetMangaTone = 0.0;
    this.targetPastelMix = 0.0;
    this.targetLightGain = 0.88;
    this.targetBrightMode = 0.0;
    this.beatTime = 0;
    this.audio = { bass: 0, mid: 0, high: 0, beat: 0, downbeat: 0, beatPhase: 0 };

    this._initBackdrop();
    this._initParticles();
    this._bindEvents();
    this.setVibe(this.vibe);

    if (!this.isHidden) {
      this._animate();
    }
  }

  _initBackdrop() {
    this.bgUniforms = {
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2(0, 0) },
      uClick: { value: new THREE.Vector2(0.5, 0.5) },
      uShock: { value: 10.0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uHigh: { value: 0 },
      uBeat: { value: 0 },
      uDownbeat: { value: 0 },
      uBeatPhase: { value: 0 },
      uSpeed: { value: 1.0 },
      uTurbulence: { value: 1.1 },
      uIntensity: { value: 1.0 },
      uAspect: { value: window.innerWidth / Math.max(1, window.innerHeight) },
      uAnimeRay: { value: 0.0 },
      uMangaTone: { value: 0.0 },
      uPastelMode: { value: 1.0 },
      uPastelMix: { value: 0.0 },
      uLightGain: { value: 0.88 },
      uColorBase: { value: this.targetColors.base.clone() },
      uColorA: { value: this.targetColors.a.clone() },
      uColorB: { value: this.targetColors.b.clone() },
    };

    this.backdropQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: BACKDROP_VERT,
        fragmentShader: BACKDROP_FRAG,
        uniforms: this.bgUniforms,
        depthWrite: false,
        depthTest: false,
      })
    );
    this.backdropQuad.renderOrder = -10;
    this.backdropQuad.frustumCulled = false;
    this.scene.add(this.backdropQuad);
  }

  _initParticles() {
    const isMobile = window.innerWidth < 768;
    const count = isMobile ? 420 : 900;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 22;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 14;
      positions[i * 3 + 2] = -2 - Math.random() * 14;
      seeds[i * 3] = Math.random();
      seeds[i * 3 + 1] = Math.random();
      seeds[i * 3 + 2] = Math.random();
    }

    this.particleGeo = new THREE.BufferGeometry();
    this.particleGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.particleGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));

    this.particleUniforms = {
      uTime: { value: 0 },
      uBeatTime: { value: 0 },
      uSpeed: { value: 1.0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uHigh: { value: 0 },
      uBeat: { value: 0 },
      uDownbeat: { value: 0 },
      uTurbulence: { value: 1.1 },
      uMode: { value: 2.0 },
      uIntensity: { value: 1.0 },
      uBrightMode: { value: 0.0 },
      uPixelRatio: { value: this.pixelRatio },
      uColorA: this.bgUniforms.uColorA,
      uColorB: this.bgUniforms.uColorB,
    };

    this.particleMat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: this.particleUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.particles = new THREE.Points(this.particleGeo, this.particleMat);
    this.scene.add(this.particles);
  }

  setVibe(vibeConfig) {
    this.vibe = { ...this.vibe, ...vibeConfig };

    const cols = vibeConfig.colors || vibeConfig.default_colors;
    if (cols && cols.length >= 3) {
      this.targetColors.base.set(cols[0]);
      this.targetColors.a.set(cols[1]);
      this.targetColors.b.set(cols[2]);
    }

    const modeKey = this.vibe.particle_mode || "float";
    const modeIdx = PARTICLE_MODE_INDEX[modeKey] ?? 0.0;
    this.particleUniforms.uMode.value = modeIdx;
    this._syncSkinTargets();
  }

  _syncSkinTargets() {
    this.targetAnimeRay = (this.vibe?.id === "anime" || this.themeSkin === "anime" || this.themeSkin === "pastel") ? 1.0 : 0.0;
    this.targetMangaTone = this.themeSkin === "manga" ? 1.0 : 0.0;

    const pIdx = PASTEL_MODE_INDEX[this.pastelBg] ?? 0.0;
    if (pIdx > 0.5) {
      this.bgUniforms.uPastelMode.value = pIdx;
      this.targetPastelMix = 1.0;
    } else {
      this.targetPastelMix = 0.0;
    }

    const isPastelLightSkin = this.themeSkin === "pastel";
    const isBrightPastelSky = this.pastelBg === "daydream" || this.pastelBg === "peach" || this.pastelBg === "ghibli";
    const bright = isPastelLightSkin || isBrightPastelSky;
    this.targetLightGain = isPastelLightSkin ? 0.98 : (isBrightPastelSky ? 0.90 : 0.88);
    this.targetBrightMode = bright ? 1.0 : 0.0;

    if (this.particleMat) {
      const wantBlend = bright ? THREE.NormalBlending : THREE.AdditiveBlending;
      if (this.particleMat.blending !== wantBlend) {
        this.particleMat.blending = wantBlend;
        this.particleMat.needsUpdate = true;
      }
    }
  }

  setVisualOptions({ intensity = "balanced", particlesEnabled = true, skin = "default", pastelBg = "off" } = {}) {
    this.visualIntensity = INTENSITY_MAP[intensity] ?? 1.0;
    this.particlesEnabled = Boolean(particlesEnabled);
    this.themeSkin = skin || "default";
    this.pastelBg = pastelBg || "off";
    if (this.particles) {
      this.particles.visible = this.particlesEnabled;
    }
    this.bgUniforms.uIntensity.value = this.visualIntensity;
    this.particleUniforms.uIntensity.value = this.visualIntensity;
    this._syncSkinTargets();
  }

  updateAudio(bass, mid, high, beat = 0, downbeat = 0, beatPhase = 0) {
    this.audio.bass = THREE.MathUtils.lerp(this.audio.bass, bass, 0.25);
    this.audio.mid = THREE.MathUtils.lerp(this.audio.mid, mid, 0.2);
    this.audio.high = THREE.MathUtils.lerp(this.audio.high, high, 0.25);
    const beatLerp = beat > this.audio.beat ? 0.78 : 0.35;
    const downLerp = downbeat > this.audio.downbeat ? 0.78 : 0.28;
    this.audio.beat = THREE.MathUtils.lerp(this.audio.beat, beat, beatLerp);
    this.audio.downbeat = THREE.MathUtils.lerp(this.audio.downbeat, downbeat, downLerp);
    this.audio.beatPhase = beatPhase;
  }

  _bindEvents() {
    this._onMouseMove = (e) => {
      this.targetMouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.targetMouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    };

    this._onTouchMove = (e) => {
      if (e.touches && e.touches[0]) {
        this.targetMouse.x = (e.touches[0].clientX / window.innerWidth) * 2 - 1;
        this.targetMouse.y = -(e.touches[0].clientY / window.innerHeight) * 2 + 1;
      }
    };

    this._onPointerDown = (e) => {
      this.clickUV.set(e.clientX / window.innerWidth, 1.0 - e.clientY / window.innerHeight);
      this.bgUniforms.uClick.value.copy(this.clickUV);
      this.shockTime = 0.0;
    };

    this._onResize = () => {
      this.pixelRatio = Math.min(window.devicePixelRatio || 1, window.innerWidth < 768 ? 1.5 : 2);
      const w = window.innerWidth;
      const h = Math.max(1, window.innerHeight);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.particleUniforms.uPixelRatio.value = this.pixelRatio;
      this.bgUniforms.uAspect.value = w / h;
    };

    this._onVisibilityChange = () => {
      this.isHidden = document.hidden;
      if (this.isHidden) {
        if (this.rafId !== null) {
          cancelAnimationFrame(this.rafId);
          this.rafId = null;
        }
      } else if (!this.isDisposed && this.rafId === null) {
        this.clock.getDelta();
        this._animate();
      }
    };

    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("touchmove", this._onTouchMove, { passive: true });
    window.addEventListener("pointerdown", this._onPointerDown);
    window.addEventListener("resize", this._onResize);
    document.addEventListener("visibilitychange", this._onVisibilityChange);
  }

  _animate() {
    if (this.isDisposed || this.isHidden) {
      this.rafId = null;
      return;
    }

    this.rafId = requestAnimationFrame(() => this._animate());

    const dt = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;
    this.shockTime += dt;
    this.beatTime += dt * (1.0 + Math.min(1.6, this.audio.beat * 1.45));

    const speed = this.vibe.speed || 1.0;
    const turbulence = this.vibe.turbulence ?? 1.0;

    this.mouse.lerp(this.targetMouse, 0.06);
    this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, this.mouse.x * 0.7, 0.05);
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, this.mouse.y * 0.45, 0.05);
    const targetZ = 7.2 - this.audio.beat * 0.16 * Math.min(1.3, this.visualIntensity);
    this.camera.position.z = THREE.MathUtils.lerp(this.camera.position.z, targetZ, 0.18);
    this.camera.lookAt(0, 0, -2);

    this.bgUniforms.uColorBase.value.lerp(this.targetColors.base, 0.035);
    this.bgUniforms.uColorA.value.lerp(this.targetColors.a, 0.035);
    this.bgUniforms.uColorB.value.lerp(this.targetColors.b, 0.035);
    this.bgUniforms.uAnimeRay.value = THREE.MathUtils.lerp(this.bgUniforms.uAnimeRay.value, this.targetAnimeRay, 0.06);
    this.bgUniforms.uMangaTone.value = THREE.MathUtils.lerp(this.bgUniforms.uMangaTone.value, this.targetMangaTone, 0.06);
    this.bgUniforms.uPastelMix.value = THREE.MathUtils.lerp(this.bgUniforms.uPastelMix.value, this.targetPastelMix, 0.06);
    this.bgUniforms.uLightGain.value = THREE.MathUtils.lerp(this.bgUniforms.uLightGain.value, this.targetLightGain, 0.06);
    this.particleUniforms.uBrightMode.value = THREE.MathUtils.lerp(this.particleUniforms.uBrightMode.value, this.targetBrightMode, 0.08);

    this.bgUniforms.uTime.value = elapsed;
    this.bgUniforms.uMouse.value.copy(this.mouse);
    this.bgUniforms.uShock.value = this.shockTime;
    this.bgUniforms.uBass.value = this.audio.bass;
    this.bgUniforms.uMid.value = this.audio.mid;
    this.bgUniforms.uHigh.value = this.audio.high;
    this.bgUniforms.uBeat.value = this.audio.beat;
    this.bgUniforms.uDownbeat.value = this.audio.downbeat;
    this.bgUniforms.uBeatPhase.value = this.audio.beatPhase;
    this.bgUniforms.uSpeed.value = speed;
    this.bgUniforms.uTurbulence.value = turbulence;

    this.particleUniforms.uTime.value = elapsed;
    this.particleUniforms.uBeatTime.value = this.beatTime;
    this.particleUniforms.uSpeed.value = speed;
    this.particleUniforms.uBass.value = this.audio.bass;
    this.particleUniforms.uMid.value = this.audio.mid;
    this.particleUniforms.uHigh.value = this.audio.high;
    this.particleUniforms.uBeat.value = this.audio.beat;
    this.particleUniforms.uDownbeat.value = this.audio.downbeat;
    this.particleUniforms.uTurbulence.value = turbulence;

    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    this.isDisposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    window.removeEventListener("mousemove", this._onMouseMove);
    window.removeEventListener("touchmove", this._onTouchMove);
    window.removeEventListener("pointerdown", this._onPointerDown);
    window.removeEventListener("resize", this._onResize);
    document.removeEventListener("visibilitychange", this._onVisibilityChange);

    this.scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
    this.renderer.dispose();
  }
}
