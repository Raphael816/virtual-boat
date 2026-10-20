/**
 * ロフト（断面スイープ）でなめらかな有機形状を作る。
 * 馬の胴・首・頭・脚、騎手の体は、すべてこの関数で断面をつないで生成する。
 *
 * 断面は「上下で半径の違う超楕円」：
 *   y = sinθ > 0 ? top·|sinθ|^(2/n) : −bottom·|sinθ|^(2/n)
 *   z = side·sign(cosθ)·|cosθ|^(2/n) · (1 − topNarrow·max(0,sinθ) − bottomNarrow·max(0,−sinθ))
 */
import * as THREE from 'three';

export interface Section {
  /** 中心位置 */
  c: THREE.Vector3;
  top: number;
  bottom: number;
  side: number;
  /** 超楕円の指数（2 = 楕円、大きいほど角ばる） */
  n?: number;
  topNarrow?: number;
  bottomNarrow?: number;
}

export interface LoftOptions {
  radial: number;
  /** 断面の間を何分割して補間するか */
  subdiv: number;
  capStart?: boolean;
  capEnd?: boolean;
  /** 断面の「上」方向（既定 +y）。脚のように上下に伸びる形では +x などを使う */
  up?: THREE.Vector3;
  /** 表面の凹凸（筋肉など）：t は 0〜1 の長さ方向、theta は断面の角度。半径方向のオフセット (m) */
  bump?: (t: number, theta: number, p: THREE.Vector3) => number;
  /** 頂点色 */
  color?: (p: THREE.Vector3, t: number, theta: number) => THREE.Color;
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** 断面列を Catmull-Rom で滑らかに補間する */
export function interpolateSections(keys: Section[], subdiv: number): Section[] {
  const out: Section[] = [];
  const get = (i: number) => keys[Math.max(0, Math.min(keys.length - 1, i))];
  for (let i = 0; i < keys.length - 1; i++) {
    for (let s = 0; s < subdiv; s++) {
      const t = s / subdiv;
      const [a, b, c, d] = [get(i - 1), get(i), get(i + 1), get(i + 2)];
      const lerpField = (k: 'top' | 'bottom' | 'side') => Math.max(0.002, catmull(a[k], b[k], c[k], d[k], t));
      const opt = (k: 'n' | 'topNarrow' | 'bottomNarrow', def: number) =>
        catmull(a[k] ?? def, b[k] ?? def, c[k] ?? def, d[k] ?? def, t);
      out.push({
        c: new THREE.Vector3(catmull(a.c.x, b.c.x, c.c.x, d.c.x, t), catmull(a.c.y, b.c.y, c.c.y, d.c.y, t), catmull(a.c.z, b.c.z, c.c.z, d.c.z, t)),
        top: lerpField('top'),
        bottom: lerpField('bottom'),
        side: lerpField('side'),
        n: opt('n', 2),
        topNarrow: opt('topNarrow', 0),
        bottomNarrow: opt('bottomNarrow', 0),
      });
    }
  }
  out.push({ ...keys[keys.length - 1], c: keys[keys.length - 1].c.clone() });
  return out;
}

/** 断面上の点（ローカルの up / side 軸に対するオフセット） */
export function sectionPoint(s: Section, theta: number): [number, number] {
  const n = s.n ?? 2;
  const sn = Math.sin(theta);
  const cs = Math.cos(theta);
  const e = 2 / n;
  const y = sn >= 0 ? s.top * Math.pow(sn, e) : -s.bottom * Math.pow(-sn, e);
  const narrow = 1 - (s.topNarrow ?? 0) * Math.max(0, sn) - (s.bottomNarrow ?? 0) * Math.max(0, -sn);
  const z = s.side * Math.sign(cs) * Math.pow(Math.abs(cs), e) * narrow;
  return [y, z];
}

export function loftGeometry(keys: Section[], opt: LoftOptions): THREE.BufferGeometry {
  let secs = interpolateSections(keys, opt.subdiv);
  // 端を丸める（半球状に縮める断面を追加）
  const capSteps = 4;
  const capRing = (s: Section, dir: THREE.Vector3, k: number): Section => {
    const a = (k / capSteps) * (Math.PI / 2);
    const len = Math.min(s.top + s.bottom, s.side * 2) * 0.45;
    return { ...s, c: s.c.clone().addScaledVector(dir, Math.sin(a) * len), top: s.top * Math.cos(a) + 0.001, bottom: s.bottom * Math.cos(a) + 0.001, side: s.side * Math.cos(a) + 0.001 };
  };
  if (opt.capStart) {
    const dir = secs[0].c.clone().sub(secs[1].c).normalize();
    const caps = [];
    for (let k = capSteps; k >= 1; k--) caps.push(capRing(secs[0], dir, k));
    secs = [...caps, ...secs];
  }
  if (opt.capEnd) {
    const last = secs[secs.length - 1];
    const dir = last.c.clone().sub(secs[secs.length - 2].c).normalize();
    for (let k = 1; k <= capSteps; k++) secs.push(capRing(last, dir, k));
  }

  const R = opt.radial;
  const N = secs.length;
  const pos = new Float32Array(N * (R + 1) * 3);
  const uv = new Float32Array(N * (R + 1) * 2);
  const col = opt.color ? new Float32Array(N * (R + 1) * 3) : null;
  const upRef = opt.up ?? new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3();
  const p = new THREE.Vector3();
  let length = 0;
  const lengths = [0];
  for (let i = 1; i < N; i++) lengths.push((length += secs[i].c.distanceTo(secs[i - 1].c)));

  for (let i = 0; i < N; i++) {
    const s = secs[i];
    const a = secs[Math.max(0, i - 1)].c;
    const b = secs[Math.min(N - 1, i + 1)].c;
    tangent.subVectors(b, a).normalize();
    side.crossVectors(tangent, upRef).normalize();
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
    up.crossVectors(side, tangent).normalize();
    const t = length > 0 ? lengths[i] / length : 0;
    for (let j = 0; j <= R; j++) {
      // 継ぎ目（θ = −π/2）は下面に置き、見えにくくする
      const theta = -Math.PI / 2 + (j / R) * Math.PI * 2;
      const [yy, zz] = sectionPoint(s, theta);
      p.copy(s.c).addScaledVector(up, yy).addScaledVector(side, zz);
      if (opt.bump) {
        const off = opt.bump(t, theta, p);
        if (off) {
          const radial = new THREE.Vector3().subVectors(p, s.c);
          const len = radial.length();
          if (len > 1e-5) p.addScaledVector(radial, off / len);
        }
      }
      const k = i * (R + 1) + j;
      pos.set([p.x, p.y, p.z], k * 3);
      uv.set([t, j / R], k * 2);
      if (col && opt.color) {
        const c = opt.color(p, t, theta);
        col.set([c.r, c.g, c.b], k * 3);
      }
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < R; j++) {
      const a = i * (R + 1) + j;
      const b = a + R + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // 継ぎ目の法線を平均して、なめらかにつなぐ
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < N; i++) {
    const a = i * (R + 1);
    const b = a + R;
    const nx = nrm.getX(a) + nrm.getX(b);
    const ny = nrm.getY(a) + nrm.getY(b);
    const nz = nrm.getZ(a) + nrm.getZ(b);
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(a, nx / l, ny / l, nz / l);
    nrm.setXYZ(b, nx / l, ny / l, nz / l);
  }
  // 法線の向きが内側になっていれば反転する（断面の回り方向に依存しないように）
  const center = secs[Math.floor(N / 2)].c;
  const mid = Math.floor(N / 2) * (R + 1) + Math.floor(R / 4);
  const outward = new THREE.Vector3(pos[mid * 3] - center.x, pos[mid * 3 + 1] - center.y, pos[mid * 3 + 2] - center.z);
  const nmid = new THREE.Vector3(nrm.getX(mid), nrm.getY(mid), nrm.getZ(mid));
  if (outward.dot(nmid) < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    g.setIndex(idx);
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
  }
  return g;
}

export function sec(x: number, y: number, z: number, top: number, bottom: number, side: number, extra: Partial<Section> = {}): Section {
  return { c: new THREE.Vector3(x, y, z), top, bottom, side, ...extra };
}

