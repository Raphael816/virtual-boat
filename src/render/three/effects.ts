/**
 * 水面の演出：モーターの水しぶき（スプレー）・引き波の泡と雨。
 * 発生位置は走行ログの艇の位置から求めるので、映像と結果が食い違うことはない。
 */
import * as THREE from 'three';
import { dustSprite, foamTexture } from './textures';

/** 水しぶき・砂煙：太陽光で照らされる柔らかいスプライト（色と大きさは呼び出し側で決める） */
export class DustSystem {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private color: Float32Array;
  private next = 0;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;

  /** 重力 (m/s²)。0 なら砂煙のように漂う */
  gravity = 0;
  drag = 1.2;
  growth = 1.6;
  opacity = 0.5;

  constructor(readonly capacity: number) {
    this.pos = new Float32Array(capacity * 3).fill(-9999);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity).fill(1);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uScale: { value: 400 }, uMap: { value: dustSprite() }, uLight: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: `attribute float psize; attribute float alpha; attribute vec3 pcolor;
        uniform float uScale; varying float vA; varying vec3 vC; varying float vRot;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * uScale / max(1.0, -mv.z); gl_Position = projectionMatrix * mv;
          vA = alpha; vC = pcolor; vRot = fract(sin(dot(position.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.283; }`,
      fragmentShader: `uniform sampler2D uMap; uniform vec3 uLight; varying float vA; varying vec3 vC; varying float vRot;
        void main(){ vec2 p = gl_PointCoord - 0.5; float c = cos(vRot), s = sin(vRot);
          p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
          vec4 t = texture2D(uMap, p); if (t.a < 0.01) discard;
          gl_FragColor = vec4(vC * uLight, vA * t.a); }`,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }

  setViewportHeight(px: number) {
    this.mat.uniforms.uScale.value = px * 0.9;
  }

  /** 光の強さ（昼は明るく、夜は照明の色） */
  setLight(c: THREE.Color) {
    (this.mat.uniforms.uLight.value as THREE.Color).copy(c);
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, c: THREE.Color) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.color.set([c.r, c.g, c.b], i * 3);
  }

  update(dt: number) {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = i * 3;
      // 水しぶき（gravity > 0）は放物線を描いて落ち、水面で消える。砂煙は舞い上がってゆっくり漂う
      this.vel[k + 1] = this.vel[k + 1] * (1 - this.drag * dt) + (this.gravity > 0 ? -this.gravity : 0.15) * dt;
      this.vel[k] *= 1 - this.drag * 1.15 * dt;
      this.vel[k + 2] *= 1 - this.drag * 1.15 * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] = this.pos[k + 1] + this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.gravity > 0 && this.pos[k + 1] < 0) this.life[i] = Math.min(this.life[i], 0.25);
      const t = this.life[i] / this.maxLife[i];
      // 出始めは素早く濃くなり、ゆっくり薄れる
      this.alpha[i] = Math.min(1, (1 - t) * 8) * t * this.opacity;
      this.size[i] += dt * this.growth;
    }
    for (const name of ['position', 'psize', 'alpha', 'pcolor']) this.geo.getAttribute(name).needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    (this.mat.uniforms.uMap.value as THREE.Texture).dispose();
  }
}

/**
 * 引き波の泡：艇の後ろに置いた泡の板が、時間とともに広がりながら薄れる。
 * 艇の走った線が水面に残るので、ターンの膨らみや差しの進路が見て分かる。
 */
export class FoamTrail {
  readonly mesh: THREE.InstancedMesh;
  private age: Float32Array;
  private life: Float32Array;
  private grow: Float32Array;
  private alpha: THREE.InstancedBufferAttribute;
  private pos: Float32Array;
  private rot: Float32Array;
  private size0: Float32Array;
  private next = 0;
  private tex = foamTexture();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3();
  private yAxis = new THREE.Vector3(0, 1, 0);

  constructor(readonly capacity: number) {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.alpha);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: this.tex }, uLight: { value: new THREE.Color(1, 1, 1) } }]),
      vertexShader: `attribute float aAlpha; varying float vA; varying vec2 vUv;
        #include <fog_pars_vertex>
        void main(){ vUv = uv; vA = aAlpha; vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `uniform sampler2D uMap; uniform vec3 uLight; varying float vA; varying vec2 vUv;
        #include <fog_pars_fragment>
        void main(){ vec4 t = texture2D(uMap, vUv); float a = t.a * vA; if (a < 0.01) discard;
          gl_FragColor = vec4(uLight, a);
          #include <fog_fragment>
        }`,
    });
    (mat.uniforms.uMap as { value: THREE.Texture }).value = this.tex;
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.age = new Float32Array(capacity).fill(999);
    this.life = new Float32Array(capacity).fill(1);
    this.grow = new Float32Array(capacity);
    this.pos = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.clear();
  }

  setLight(c: THREE.Color) {
    ((this.mesh.material as THREE.ShaderMaterial).uniforms.uLight.value as THREE.Color).copy(c);
  }

  /** 泡を1つ置く（size: 初期の大きさ m、grow: 広がる速さ m/s、life: 消えるまでの秒） */
  add(x: number, y: number, z: number, heading: number, size: number, grow: number, life: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.pos.set([x, y, z], i * 3);
    this.rot[i] = -heading + Math.random() * 0.6 - 0.3;
    this.size0[i] = size;
    this.grow[i] = grow;
    this.life[i] = life;
    this.age[i] = 0;
  }

  update(dt: number) {
    const a = this.alpha.array as Float32Array;
    for (let i = 0; i < this.capacity; i++) {
      if (this.age[i] > this.life[i]) {
        if (a[i] !== 0) {
          a[i] = 0;
          this.m.makeScale(0, 0, 0);
          this.mesh.setMatrixAt(i, this.m);
        }
        continue;
      }
      this.age[i] += dt;
      const k = this.age[i] / this.life[i];
      a[i] = Math.max(0, (1 - k) ** 1.5) * 0.85;
      const s = this.size0[i] + this.grow[i] * this.age[i];
      this.q.setFromAxisAngle(this.yAxis, this.rot[i]);
      this.v.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      this.sc.set(s * 1.6, 1, s);
      this.m.compose(this.v, this.q, this.sc);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }

  clear() {
    this.m.makeScale(0, 0, 0);
    const a = this.alpha.array as Float32Array;
    for (let i = 0; i < this.capacity; i++) {
      this.age[i] = 999;
      a[i] = 0;
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.tex.dispose();
  }
}

export class RainSystem {
  readonly lines: THREE.LineSegments;
  private pos: Float32Array;
  private geo = new THREE.BufferGeometry();
  private mat = new THREE.LineBasicMaterial({ color: '#c3ccd6', transparent: true, opacity: 0.35 });
  private readonly box = 70;

  constructor(private count: number) {
    this.pos = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) this.reset(i, 0, 0, true);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(this.geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
  }

  private reset(i: number, cx: number, cz: number, anyHeight: boolean) {
    const x = cx + (Math.random() - 0.5) * this.box;
    const z = cz + (Math.random() - 0.5) * this.box;
    const y = (anyHeight ? Math.random() : 1) * 22;
    this.pos.set([x, y, z, x + 0.05, y - 0.45, z], i * 6);
  }

  setIntensity(level: 0 | 1 | 2) {
    this.lines.visible = level > 0;
    this.geo.setDrawRange(0, level === 2 ? this.count * 2 : Math.floor(this.count * 0.9));
    this.mat.opacity = level === 2 ? 0.22 : 0.14;
  }

  /** カメラの前方に雨を降らせる（望遠でも見えるように注視点の周りに置く） */
  update(dt: number, center: THREE.Vector3) {
    if (!this.lines.visible) return;
    const fall = 26 * dt;
    for (let i = 0; i < this.count; i++) {
      const k = i * 6;
      this.pos[k + 1] -= fall;
      this.pos[k + 4] -= fall;
      const dx = this.pos[k] - center.x;
      const dz = this.pos[k + 2] - center.z;
      if (this.pos[k + 4] < 0 || Math.abs(dx) > this.box / 2 || Math.abs(dz) > this.box / 2) this.reset(i, center.x, center.z, false);
    }
    this.geo.getAttribute('position').needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
