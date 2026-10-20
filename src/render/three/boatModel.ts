/**
 * 競走艇（ハイドロプレーン）と選手の手続き型モデル。外部の3Dモデルや写真は使わない。
 *
 * - 艇体：上から見た形を押し出し、面取りした船体。デッキは白、底は濃い灰色
 * - 番号：舳先の両側に艇番の色の番号板
 * - モーター：船尾のカウリングとシャフト（水面下に沈む）
 * - 選手：艇番の色のカポック（背番号つき）とヘルメット。膝をついた前傾姿勢
 *
 * 姿勢：速度に応じて艇首が上がり、ターンでは内側へ傾く。波の高さに応じて上下に揺れる。
 * 座標：艇のローカル +x が進行方向、+y が上。
 */
import * as THREE from 'three';
import { numberTexture } from './textures';

export type Detail = 'low' | 'medium' | 'high';

export interface BoatLook {
  number: number;
  color: string;
  fg: string;
}

const LENGTH = 3.0;
const BEAM = 1.35;

function hullGeometry(detail: Detail): THREE.BufferGeometry {
  // 上から見た輪郭（x: 前後、y: 左右）。舳先は丸く絞り、船尾は平ら
  const s = new THREE.Shape();
  const h = BEAM / 2;
  const L = LENGTH / 2;
  s.moveTo(-L, -h * 0.92);
  s.lineTo(L * 0.25, -h);
  s.bezierCurveTo(L * 0.8, -h, L, -h * 0.45, L, 0);
  s.bezierCurveTo(L, h * 0.45, L * 0.8, h, L * 0.25, h);
  s.lineTo(-L, h * 0.92);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.26,
    bevelEnabled: true,
    bevelThickness: 0.06,
    bevelSize: 0.05,
    bevelSegments: detail === 'low' ? 1 : 3,
    curveSegments: detail === 'low' ? 6 : 14,
  });
  // 押し出し方向（+z）を上（+y）に
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0.06, 0);
  return g;
}

export class BoatModel {
  readonly root = new THREE.Group();
  /** 姿勢（傾き・ピッチ）を付ける内側のグループ */
  private body = new THREE.Group();
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private highlight: THREE.Mesh;
  private lastHeading = NaN;
  private roll = 0;
  private pitch = 0;
  private lastV = 0;
  private phase = Math.random() * Math.PI * 2;
  /** モーター付近（水しぶきの発生位置）の世界座標 */
  readonly stern = new THREE.Vector3();
  readonly bow = new THREE.Vector3();

  constructor(
    readonly look: BoatLook,
    detail: Detail,
    opts: { shadows: boolean },
  ) {
    const seg = detail === 'low' ? 8 : detail === 'medium' ? 14 : 20;
    const mat = <T extends THREE.Material>(m: T): T => {
      this.materials.push(m);
      return m;
    };
    const deck = mat(new THREE.MeshStandardMaterial({ color: '#f1f3f5', roughness: 0.35, metalness: 0.05 }));
    const bottom = mat(new THREE.MeshStandardMaterial({ color: '#3a3f45', roughness: 0.5 }));
    const team = mat(new THREE.MeshStandardMaterial({ color: look.color, roughness: 0.55 }));
    const dark = mat(new THREE.MeshStandardMaterial({ color: '#1d2126', roughness: 0.4, metalness: 0.3 }));
    const metal = mat(new THREE.MeshStandardMaterial({ color: '#9aa2aa', roughness: 0.3, metalness: 0.8 }));
    const visor = mat(new THREE.MeshStandardMaterial({ color: '#15181c', roughness: 0.1, metalness: 0.6 }));

    // 艇体（デッキ）と船底
    const hull = new THREE.Mesh(hullGeometry(detail), deck);
    const keel = new THREE.Mesh(new THREE.BoxGeometry(LENGTH * 0.92, 0.1, BEAM * 0.86), bottom);
    keel.position.set(-0.05, 0.04, 0);
    // 舳先のライン（艇番の色）
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(LENGTH * 0.62, 0.05, BEAM + 0.1), team);
    stripe.position.set(-0.25, 0.25, 0);
    // コクピット（くぼみ）
    const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.06, 0.8), dark);
    cockpit.position.set(-0.35, 0.37, 0);
    this.body.add(hull, keel, stripe, cockpit);

    // 番号板（舳先の両側）
    const numTex = numberTexture(look.number, look.color, look.fg);
    this.textures.push(numTex);
    const numMat = mat(new THREE.MeshStandardMaterial({ map: numTex, roughness: 0.5 }));
    for (const side of [-1, 1]) {
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.24), numMat);
      plate.position.set(0.75, 0.2, side * (BEAM / 2 + 0.051));
      plate.rotation.y = side > 0 ? 0 : Math.PI;
      this.body.add(plate);
    }
    // 舳先の上の番号（上空からも見える）
    const topPlate = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.36), numMat);
    topPlate.rotation.x = -Math.PI / 2;
    topPlate.rotation.z = -Math.PI / 2;
    topPlate.position.set(0.95, 0.385, 0);
    this.body.add(topPlate);

    // モーター
    const cowl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.36), dark);
    cowl.position.set(-LENGTH / 2 - 0.16, 0.62, 0);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.3), metal);
    cap.position.set(-LENGTH / 2 - 0.16, 0.86, 0);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.9, 8), metal);
    shaft.position.set(-LENGTH / 2 - 0.2, 0.05, 0);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 0.05), metal);
    fin.position.set(-LENGTH / 2 - 0.2, -0.35, 0);
    this.body.add(cowl, cap, shaft, fin);

    // 選手（膝をついた前傾姿勢）
    const rider = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.42, 3, seg), team);
    torso.rotation.z = -0.85; // 前傾
    torso.position.set(-0.32, 0.72, 0);
    const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.46, 3, seg), dark);
    legs.rotation.z = Math.PI / 2;
    legs.position.set(-0.6, 0.48, 0);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, seg, Math.max(6, seg / 2)), team);
    head.position.set(-0.02, 0.98, 0);
    const shield = new THREE.Mesh(new THREE.SphereGeometry(0.152, seg, Math.max(6, seg / 2), -0.9, 1.8, 1.0, 0.7), visor);
    shield.rotation.y = Math.PI / 2;
    shield.position.copy(head.position);
    rider.add(torso, legs, head, shield);
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.42, 2, 6), team);
      arm.rotation.z = -1.25;
      arm.position.set(-0.08, 0.72, side * 0.2);
      rider.add(arm);
    }
    // 背番号
    const back = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), numMat);
    back.position.set(-0.47, 0.88, 0);
    back.rotation.set(0, -Math.PI / 2, 0);
    back.rotateX(-0.72);
    rider.add(back);
    // ハンドル
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.02, 6, 16), dark);
    wheel.position.set(0.16, 0.6, 0);
    wheel.rotation.y = Math.PI / 2;
    wheel.rotation.x = 0.4;
    rider.add(wheel);
    this.body.add(rider);

    this.body.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = opts.shadows;
        m.layers.enable(1); // ポストプロセスのモーションブラーのマスク用
      }
    });

    // 注目艇の目印（水面の輪）
    this.highlight = new THREE.Mesh(
      new THREE.RingGeometry(1.9, 2.2, 40).rotateX(-Math.PI / 2),
      mat(new THREE.MeshBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.85, depthWrite: false })),
    );
    this.highlight.position.y = 0.05;
    this.highlight.visible = false;
    this.root.add(this.body, this.highlight);
    this.root.rotation.order = 'YXZ';
  }

  setHighlight(on: boolean) {
    this.highlight.visible = on;
  }

  /**
   * 位置と姿勢を更新する。
   * @param heading 進行方向（ラジアン、+x が 0、+z が +π/2）
   * @param v 速度 (m/s)
   * @param wave 波高 (m)
   */
  update(x: number, z: number, heading: number, v: number, dt: number, time: number, wave: number) {
    let omega = 0;
    if (dt > 0 && !Number.isNaN(this.lastHeading)) {
      let dh = heading - this.lastHeading;
      if (dh > Math.PI) dh -= Math.PI * 2;
      if (dh < -Math.PI) dh += Math.PI * 2;
      omega = dh / dt;
    }
    this.lastHeading = heading;
    const acc = dt > 0 ? (v - this.lastV) / dt : 0;
    this.lastV = v;
    // ターンでは内側へ傾く（横方向の加速度から）。艇首は速度と加速で上がる
    const rollTarget = 0.42 * Math.atan((v * omega) / 9.8);
    const pitchTarget = (v > 4 ? 0.045 : 0.01) + Math.max(-0.02, Math.min(0.05, acc * 0.012));
    const k = Math.min(1, dt * 5);
    this.roll += (rollTarget - this.roll) * k;
    this.pitch += (pitchTarget - this.pitch) * k;
    // 波による揺れ（艇ごとに位相をずらす）
    const bob = Math.sin(time * 2.3 + this.phase) * wave * 0.35 + Math.sin(time * 3.7 + this.phase * 2) * wave * 0.15;
    const sway = Math.sin(time * 1.7 + this.phase) * wave * 0.25;
    this.root.position.set(x, bob - 0.12, z);
    this.root.rotation.set(0, -heading, 0);
    this.body.rotation.order = 'XZY';
    this.body.rotation.set(this.roll + sway, 0, this.pitch + Math.cos(time * 2.3 + this.phase) * wave * 0.08);
    const ch = Math.cos(heading);
    const sh = Math.sin(heading);
    this.stern.set(x - ch * (LENGTH / 2 + 0.25), 0.15, z - sh * (LENGTH / 2 + 0.25));
    this.bow.set(x + ch * (LENGTH / 2 - 0.2), 0.1, z + sh * (LENGTH / 2 - 0.2));
  }

  dispose() {
    this.root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
  }
}
