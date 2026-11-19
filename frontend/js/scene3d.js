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

    // Liquid mesh flow
    vec2 q = vec2(
      fbm(uv * 2.1 + vec2(t, -t * 0.6) + uMouse * 0.3),
      fbm(uv * 2.1 + vec2(-t * 0.5, t * 0.8))
    );
    float f = fbm(uv * 2.4 + q * (1.65 + uBass * 1.1));

    vec3 col = mix(uColorBase, uColorA, smoothstep(0.2, 0.8, f));
    col = mix(col, uColorB, smoothstep(0.48, 0.96, length(q) * 0.72 + uBass * 0.22));

    // Soft cursor glow
    float cursorGlow = exp(-length(vUv - (uMouse * 0.5 + 0.5)) * 4.0) * (0.14 + uBass * 0.18);
    col += uColorB * cursorGlow;

    gl_FragColor = vec4(col * 0.7, 1.0);
  }
`;

export class VibeScene3D {
  constructor(canvas) {
    this.canvas = canvas;
    const isMobile = window.innerWidth < 768;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.position.set(0, 0, 7.2);

    this.clock = new THREE.Clock();
    this.mouse = new THREE.Vector2(0, 0);
    this.targetMouse = new THREE.Vector2(0, 0);
    this.clickUV = new THREE.Vector2(0.5, 0.5);
    this.shockTime = 10.0;

    this.targetColors = {
      base: new THREE.Color("#0f0728"),
      a: new THREE.Color("#ec4899"),
      b: new THREE.Color("#06b6d4"),
    };

    this.vibe = {
      id: "synth",
      particle_mode: "warp",
      speed: 1.15,
    };

    this.audio = { bass: 0, mid: 0, high: 0 };

    this._initBackdrop();
    this._initParticles();
    this._bindEvents();
    this._animate();
  }

  _initBackdrop() {
    this.bgUniforms = {
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2(0, 0) },
      uClick: { value: new THREE.Vector2(0.5, 0.5) },
      uShock: { value: 10.0 },
      uBass: { value: 0 },
      uSpeed: { value: 1.0 },
      uColorBase: { value: this.targetColors.base.clone() },
      uColorA: { value: this.targetColors.a.clone() },
      uColorB: { value: this.targetColors.b.clone() },
    };

    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: BACKDROP_VERT,
        fragmentShader: BACKDROP_FRAG,
        uniforms: this.bgUniforms,
        depthWrite: false,
        depthTest: false,
      })
    );
    quad.renderOrder = -10;
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  _initParticles() {
    const isMobile = window.innerWidth < 768;
    const count = isMobile ? 420 : 900;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 22;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 14;
      positions[i * 3 + 2] = -2 - Math.random() * 14;
      seeds[i] = Math.random();
    }

    this.particleGeo = new THREE.BufferGeometry();
    this.particleGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.particleSeeds = seeds;

    this.particleMat = new THREE.PointsMaterial({
      color: this.targetColors.b.clone(),
      size: 0.05,
      transparent: true,
      opacity: 0.42,
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
  }

  updateAudio(bass, mid, high) {
    this.audio.bass = THREE.MathUtils.lerp(this.audio.bass, bass, 0.25);
    this.audio.mid = THREE.MathUtils.lerp(this.audio.mid, mid, 0.2);
    this.audio.high = THREE.MathUtils.lerp(this.audio.high, high, 0.25);
  }

  _bindEvents() {
    window.addEventListener("mousemove", (e) => {
      this.targetMouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.targetMouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    });

    window.addEventListener("touchmove", (e) => {
      if (e.touches && e.touches[0]) {
        this.targetMouse.x = (e.touches[0].clientX / window.innerWidth) * 2 - 1;
        this.targetMouse.y = -(e.touches[0].clientY / window.innerHeight) * 2 + 1;
      }
    }, { passive: true });

    window.addEventListener("pointerdown", (e) => {
      this.clickUV.set(e.clientX / window.innerWidth, 1.0 - e.clientY / window.innerHeight);
      this.bgUniforms.uClick.value.copy(this.clickUV);
      this.shockTime = 0.0;
    });

    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.innerWidth < 768 ? 1.5 : 2));
    });
  }

  _animate() {
    requestAnimationFrame(() => this._animate());

    const dt = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;
    this.shockTime += dt;

    this.mouse.lerp(this.targetMouse, 0.06);
    this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, this.mouse.x * 0.7, 0.05);
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, this.mouse.y * 0.45, 0.05);
    this.camera.lookAt(0, 0, -2);

    // Smooth color transitions
    this.bgUniforms.uColorBase.value.lerp(this.targetColors.base, 0.035);
    this.bgUniforms.uColorA.value.lerp(this.targetColors.a, 0.035);
    this.bgUniforms.uColorB.value.lerp(this.targetColors.b, 0.035);
    this.particleMat.color.lerp(this.targetColors.b, 0.04);

    this.bgUniforms.uTime.value = elapsed;
    this.bgUniforms.uMouse.value.copy(this.mouse);
    this.bgUniforms.uShock.value = this.shockTime;
    this.bgUniforms.uBass.value = this.audio.bass;
    this.bgUniforms.uSpeed.value = this.vibe.speed || 1.0;

    // Subtle vibe-matched background particles
    const pos = this.particleGeo.attributes.position;
    const mode = this.vibe.particle_mode;
    const boost = 1.0 + this.audio.bass * 3.0;

    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);
      const seed = this.particleSeeds[i];

      if (mode === "rain") {
        y -= dt * (3.8 + seed * 3.0);
        x -= dt * 0.4;
        if (y < -7) { y = 7; x = (Math.random() - 0.5) * 22; }
      } else if (mode === "embers") {
        y += dt * (1.6 + seed * 2.0) * boost;
        x += Math.sin(elapsed * 2.0 + seed * 12.0) * dt * 0.6;
        if (y > 7) y = -7;
      } else if (mode === "warp") {
        z += dt * (2.8 + seed * 3.2) * boost;
        if (z > 2) z = -15;
      } else if (mode === "burst") {
        const radial = dt * (0.4 + this.audio.bass * 3.2);
        x += x * radial * 0.22;
        y += y * radial * 0.22;
        if (Math.abs(x) > 12 || Math.abs(y) > 8) {
          x = (Math.random() - 0.5) * 3;
          y = (Math.random() - 0.5) * 3;
        }
      } else {
        y += Math.sin(elapsed * 0.55 + seed * 20.0) * dt * 0.3;
        x += Math.cos(elapsed * 0.35 + seed * 15.0) * dt * 0.22;
      }
      pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }
}