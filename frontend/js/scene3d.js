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
  uniform float uSpeed;
  uniform float uTurbulence;
  uniform vec3 uColorBase;
  uniform vec3 uColorA;
  uniform vec3 uColorB;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise(p);
      p = p * 2.04 + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv;
    float t = uTime * 0.2 * uSpeed;

    // Interactive click ripple
    float dClick = length(uv - uClick);
    float ripple = sin(dClick * 26.0 - uShock * 18.0) * exp(-dClick * 4.5) * exp(-uShock * 2.5);
    uv += normalize(uv - uClick + 0.0001) * ripple * 0.03;

    // Liquid mesh flow modulated by turbulence & bass
    float turb = clamp(uTurbulence, 0.3, 2.5);
    vec2 q = vec2(
      fbm(uv * (1.85 + turb * 0.22) + vec2(t, -t * 0.6) + uMouse * 0.3),
      fbm(uv * (1.85 + turb * 0.22) + vec2(-t * 0.5, t * 0.8))
    );
    float f = fbm(uv * 2.4 + q * (1.45 + turb * 0.28 + uBass * 1.1));

    vec3 col = mix(uColorBase, uColorA, smoothstep(0.2, 0.8, f));
    col = mix(col, uColorB, smoothstep(0.48, 0.96, length(q) * 0.72 + uBass * 0.22));

    // Soft cursor glow
    float cursorGlow = exp(-length(vUv - (uMouse * 0.5 + 0.5)) * 4.0) * (0.14 + uBass * 0.18);
    col += uColorB * cursorGlow;

    gl_FragColor = vec4(col * 0.7, 1.0);
  }
`;

const PARTICLE_VERT = `
  attribute vec3 aSeed;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uBass;
  uniform float uTurbulence;
  uniform float uMode;
  uniform float uPixelRatio;
  varying float vSeed;
  varying float vAlpha;

  void main() {
    vec3 p = position;
    float s1 = aSeed.x;
    float s2 = aSeed.y;
    float s3 = aSeed.z;
    float boost = 1.0 + uBass * 2.2;
    float t = uTime * (0.55 + uSpeed * 0.45);

    if (uMode > 2.5 && uMode < 3.5) {
      // Rain: downward diagonal streaks
      float spanY = 14.0;
      p.y = 7.0 - mod(7.0 - p.y + uTime * (3.6 + s1 * 2.8), spanY);
      p.x = mod(p.x - uTime * 0.45 + 11.0, 22.0) - 11.0;
    } else if (uMode > 3.5 && uMode < 4.5) {
      // Embers: turbulent rising sparks
      float spanY = 14.0;
      p.y = mod(p.y + 7.0 + uTime * (1.5 + s1 * 1.9) * boost, spanY) - 7.0;
      p.x += sin(uTime * 2.1 + s2 * 18.0) * 0.55 * uTurbulence;
    } else if (uMode > 1.5 && uMode < 2.5) {
      // Warp: stars flying forward toward camera
      float spanZ = 17.0;
      p.z = mod(p.z + 15.0 + uTime * (2.6 + s1 * 3.0) * boost, spanZ) - 15.0;
    } else if (uMode > 0.5 && uMode < 1.5) {
      // Burst: radial pulse expansion
      float cycle = fract(s3 + uTime * (0.18 + uBass * 0.35) * max(0.5, uSpeed));
      float angle = s2 * 6.2831853;
      float radius = 0.8 + cycle * 10.5;
      p.x = cos(angle) * radius * 1.35;
      p.y = sin(angle) * radius * 0.9;
      p.z = -3.0 - (1.0 - cycle) * 8.0;
    } else if (uMode > 4.5) {
      // Stardust: orbital drift
      float drift = t * 0.4 + s2 * 6.28318;
      p.x += cos(drift) * 0.6;
      p.y += sin(drift * 1.3 + s1 * 10.0) * 0.5;
    } else {
      // Float: gentle ambient suspension
      p.y += sin(uTime * 0.55 + s1 * 20.0) * 0.55;
      p.x += cos(uTime * 0.35 + s2 * 15.0) * 0.45;
    }

    vSeed = s1;
    vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPos;

    float depthFade = clamp(1.0 - (-mvPos.z / 20.0), 0.15, 1.0);
    vAlpha = depthFade * (0.35 + 0.35 * sin(uTime * 1.4 + s2 * 12.0) + uBass * 0.25);

    float baseSize = (16.0 + s1 * 14.0 + uBass * 12.0) * uPixelRatio;
    gl_PointSize = clamp(baseSize / max(1.0, -mvPos.z), 1.5, 14.0);
  }
`;

const PARTICLE_FRAG = `
  precision mediump float;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying float vSeed;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float glow = smoothstep(0.5, 0.05, d);
    vec3 col = mix(uColorB, uColorA, vSeed * 0.55);
    gl_FragColor = vec4(col, glow * clamp(vAlpha, 0.0, 0.72));
  }
`;

const PARTICLE_MODE_INDEX = {
  float: 0.0,
  burst: 1.0,
  warp: 2.0,
  rain: 3.0,
  embers: 4.0,
  stardust: 5.0,
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

    this.audio = { bass: 0, mid: 0, high: 0 };

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
      uSpeed: { value: 1.0 },
      uTurbulence: { value: 1.1 },
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
      uSpeed: { value: 1.0 },
      uBass: { value: 0 },
      uTurbulence: { value: 1.1 },
      uMode: { value: 2.0 },
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
    this.particleUniforms.uMode.value = PARTICLE_MODE_INDEX[modeKey] ?? 0.0;
  }

  updateAudio(bass, mid, high) {
    this.audio.bass = THREE.MathUtils.lerp(this.audio.bass, bass, 0.25);
    this.audio.mid = THREE.MathUtils.lerp(this.audio.mid, mid, 0.2);
    this.audio.high = THREE.MathUtils.lerp(this.audio.high, high, 0.25);
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
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.particleUniforms.uPixelRatio.value = this.pixelRatio;
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

    const speed = this.vibe.speed || 1.0;
    const turbulence = this.vibe.turbulence ?? 1.0;

    this.mouse.lerp(this.targetMouse, 0.06);
    this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, this.mouse.x * 0.7, 0.05);
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, this.mouse.y * 0.45, 0.05);
    this.camera.lookAt(0, 0, -2);

    // Smooth color transitions
    this.bgUniforms.uColorBase.value.lerp(this.targetColors.base, 0.035);
    this.bgUniforms.uColorA.value.lerp(this.targetColors.a, 0.035);
    this.bgUniforms.uColorB.value.lerp(this.targetColors.b, 0.035);

    this.bgUniforms.uTime.value = elapsed;
    this.bgUniforms.uMouse.value.copy(this.mouse);
    this.bgUniforms.uShock.value = this.shockTime;
    this.bgUniforms.uBass.value = this.audio.bass;
    this.bgUniforms.uSpeed.value = speed;
    this.bgUniforms.uTurbulence.value = turbulence;

    this.particleUniforms.uTime.value = elapsed;
    this.particleUniforms.uSpeed.value = speed;
    this.particleUniforms.uBass.value = this.audio.bass;
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
