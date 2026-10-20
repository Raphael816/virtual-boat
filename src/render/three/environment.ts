/**
 * ボートレース場の環境。水面の形は江戸川の公開情報（河川の水面・1マーク付近の幅約37m・スタンド寄りの1マーク・横ピット）を
 * 参考にした非公式の再現（core/course.ts）。建物・施設の外観は公式の図面や写真を使わず、一般的な構成から作ったオリジナル。
 * 位置・規模を資料で確認できなかったもの（スタンドの規模、大時計・ピットの位置、対岸の街並み、橋）は推定で、
 * docs/05-venue-reference.md に記載している。
 *
 * - 空：物理ベースの空（Preetham）＋雲の層。空から環境光（IBL）を作り、水面に映り込ませる
 * - 水面：2枚のさざ波の法線を流して重ねた反射する水面。波高に応じて凹凸を強める
 * - スタンド側の岸：護岸・エプロン・2層スタンド（観客つき）・横ピット
 * - 水面の設備：ターンマーク・コースの外側を示すブイ・スタートラインの標識・大時計
 * - 対岸：堤防（芝）・木立・住宅と中層の建物・遠景の街並みと橋（霧で霞む）
 * - 吹き流し：スタンドの屋上で風向き・風速を示す
 */
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MARK_1, MARK_2, R0, START_X, WIDTH, WIDTH_AT_1M, SEGMENTS, pointAt } from '../../core/course';
import type { Tide, TimeOfDay, Weather } from '../../core/sim';
import { LEAD } from '../../core/sim';
import { seededRandom } from './noise';
import { boardTexture, clockFaceTexture, cloudField, cloudTexture, facadeTexture, glowSprite, grassTextures, seatTexture, waterNormal } from './textures';

export interface EnvQuality {
  level: 'low' | 'medium' | 'high';
  crowd: number;
  trees: number;
  shadows: boolean;
  shadowSize: number;
}

/** スタンド側の岸（護岸）の z 座標 */
export const STAND_BANK_Z = R0 + WIDTH + 8;
/** スタンドの観客席の前面 */
export const STAND_Z = STAND_BANK_Z + 10;
/** スタンドの中心（スタートラインと1マークの間。推定） */
export const STAND_X = START_X + 40;
export const STAND_HALF = 115;
/** 対岸の水際 */
export const FAR_BANK_Z = -200;
/** 大時計の位置（1マークの先の水上。推定） */
export const CLOCK_POS = new THREE.Vector3(MARK_1.x + 80, 0, -12);
/** 横ピット（スタンド側、2マーク寄り。推定） */
export const PIT_X = MARK_2.x - 70;

/** 人型の観客。シェーダーで揺れと盛り上がりを付ける */
function crowdMaterial(uniforms: { uTime: { value: number }; uExcite: { value: number } }): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uExcite = uniforms.uExcite;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uExcite;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float ph = fract(sin(float(gl_InstanceID) * 12.9898) * 43758.5453);
         float sway = sin(uTime * (1.2 + ph * 1.5) + ph * 30.0) * 0.03;
         float jump = uExcite * max(0.0, sin(uTime * (5.0 + ph * 3.0) + ph * 20.0)) * (0.12 + 0.2 * ph);
         transformed.x += sway * position.y;
         transformed.y += jump;`,
      );
  };
  return m;
}

export class Environment {
  readonly group = new THREE.Group();
  readonly sun = new THREE.DirectionalLight('#fff4e0', 3);
  private fill = new THREE.DirectionalLight('#cfe0ff', 0);
  private hemi = new THREE.HemisphereLight('#bcd3e8', '#4a5a3a', 0.25);
  private sky = new Sky();
  private clouds: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private cloudData = cloudField(512, 256);
  private cloudTex: THREE.CanvasTexture | null = null;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private sunDir = new THREE.Vector3(0.4, 0.7, 0.4).normalize();
  private waterMat: THREE.MeshStandardMaterial;
  private waterTime = { value: 0 };
  private waterFlow = { value: new THREE.Vector2(0, 0) };
  private lampMat = new THREE.MeshStandardMaterial({ color: '#2a2d30', emissive: '#000000', roughness: 0.5 });
  private windowMat = new THREE.MeshStandardMaterial({ color: '#2a3542', emissive: '#000000', roughness: 0.15, metalness: 0.6 });
  private glows: THREE.Sprite[] = [];
  private board: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private crowdUniforms = { uTime: { value: 0 }, uExcite: { value: 0 } };
  private shadowRadius = 60;
  private clockHand = new THREE.Group();
  private flags: THREE.Mesh[] = [];
  private flagUniforms = { uTime: { value: 0 }, uWind: { value: 0 } };

  constructor(
    private scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    private q: EnvQuality,
  ) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    scene.add(this.group, this.sun, this.sun.target, this.fill, this.fill.target, this.hemi);
    this.sky.scale.setScalar(4000);
    scene.add(this.sky);
    this.sun.castShadow = q.shadows;
    if (q.shadows) {
      this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      this.sun.shadow.bias = -0.0002;
      this.sun.shadow.normalBias = 0.03;
      const s = this.sun.shadow.camera;
      s.near = 1;
      s.far = 1200;
    }
    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(2600, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false, side: THREE.BackSide }),
    );
    scene.add(this.clouds);

    const rnd = seededRandom('venue:midorikawa');
    const big = q.level !== 'low';

    // ---- 水面 ----
    const normal = waterNormal(big ? 256 : 128);
    const W = 4000;
    const D = STAND_BANK_Z - FAR_BANK_Z + 10;
    normal.repeat.set(W / 34, D / 34);
    this.waterMat = new THREE.MeshStandardMaterial({ color: '#2b4a4f', roughness: 0.12, metalness: 0, normalMap: normal, normalScale: new THREE.Vector2(0.2, 0.2) });
    this.waterMat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.waterTime;
      sh.uniforms.uFlow = this.waterFlow;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec2 uFlow;').replace(
        '#include <normal_fragment_maps>',
        `#ifdef USE_NORMALMAP_TANGENTSPACE
          vec2 wuv = vNormalMapUv + uFlow * uTime;
          vec3 n1 = texture2D(normalMap, wuv + vec2(uTime * 0.011, uTime * 0.006)).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(normalMap, wuv * 2.7 + vec2(-uTime * 0.019, uTime * 0.014)).xyz * 2.0 - 1.0;
          vec3 mapN = normalize(vec3(n1.xy + n2.xy * 0.6, n1.z * n2.z));
          mapN.xy *= normalScale;
          normal = normalize(tbn * mapN);
        #endif`,
      );
    };
    const water = new THREE.Mesh(new THREE.PlaneGeometry(W, D, 1, 1).rotateX(-Math.PI / 2), this.waterMat);
    water.position.set(0, 0, (STAND_BANK_Z + FAR_BANK_Z) / 2);
    water.receiveShadow = true;
    this.group.add(water);

    this.addBanks(big, rnd);
    this.addGrandstand(rnd);
    this.addCrowd(rnd);
    this.addPit();
    this.addCourseMarks(big);
    this.addClock();
    this.addFarSide(rnd);
    this.addFlags();

    // 大型映像装置（スタンド横・2マーク寄り。位置は推定）
    this.board = new THREE.Mesh(new THREE.PlaneGeometry(30, 10), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    const boardGroup = new THREE.Group();
    const frameMat = new THREE.MeshStandardMaterial({ color: '#30353a', roughness: 0.6 });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(32, 12, 1.2), frameMat);
    frame.position.set(0, 0, -0.7);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(1.5, 10, 1.5), frameMat);
    legs.position.set(0, -11, -1);
    boardGroup.add(this.board, frame, legs);
    boardGroup.position.set(STAND_X - STAND_HALF - 30, 16, STAND_BANK_Z + 6);
    boardGroup.lookAt(STAND_X - STAND_HALF - 30 + 40, 16, 0);
    this.group.add(boardGroup);
  }

  /** 岸：スタンド側の護岸とエプロン、対岸の堤防 */
  private addBanks(big: boolean, rnd: () => number) {
    const concrete = new THREE.MeshStandardMaterial({ color: '#9ea3a6', roughness: 0.9 });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(4000, 2.2, 1.2), concrete);
    wall.position.set(0, 0.1, STAND_BANK_Z + 0.6);
    wall.receiveShadow = true;
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(4000, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#8c9093', roughness: 1 }));
    apron.position.set(0, 1.2, STAND_BANK_Z + 1.2 + 200);
    apron.receiveShadow = true;
    this.group.add(wall, apron);

    // 対岸の堤防（水際から上り、天端は道路、その先は街）
    const grass = grassTextures(big ? 256 : 128);
    grass.map.repeat.set(200, 4);
    grass.normal.repeat.set(200, 4);
    const levee = new THREE.MeshStandardMaterial({ map: grass.map, normalMap: grass.normal, roughness: 0.95, color: '#c7d1b6' });
    const prof: [number, number][] = [
      [FAR_BANK_Z + 2, -0.5],
      [FAR_BANK_Z - 4, 0.6],
      [FAR_BANK_Z - 30, 1.2],
      [FAR_BANK_Z - 44, 9],
      [FAR_BANK_Z - 52, 9],
      [FAR_BANK_Z - 64, 4],
      [FAR_BANK_Z - 600, 4],
    ];
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const X0 = -2000;
    const X1 = 2000;
    prof.forEach(([z, y], i) => {
      pos.push(X0, y, z, X1, y, z);
      uv.push(0, i / (prof.length - 1), 1, i / (prof.length - 1));
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    if (g.getAttribute('normal').getY(0) < 0) {
      g.setIndex(idx.map((_, i) => idx[i - (i % 3) + (2 - (i % 3))]));
      g.computeVertexNormals();
    }
    const leveeMesh = new THREE.Mesh(g, levee);
    leveeMesh.receiveShadow = true;
    this.group.add(leveeMesh);
    // 天端の道路
    const road = new THREE.Mesh(new THREE.PlaneGeometry(4000, 6).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#55595d', roughness: 0.9 }));
    road.position.set(0, 9.03, FAR_BANK_Z - 48);
    this.group.add(road);
    // 河川敷の木立（水際と堤防の間）
    const crown = new THREE.IcosahedronGeometry(1, 1);
    const trunk = new THREE.CylinderGeometry(0.15, 0.22, 1, 5);
    const n = Math.round(this.q.trees * 0.6);
    const crowns = new THREE.InstancedMesh(crown, new THREE.MeshStandardMaterial({ color: '#4b6a3a', roughness: 0.95 }), n);
    const trunks = new THREE.InstancedMesh(trunk, new THREE.MeshStandardMaterial({ color: '#5a4636', roughness: 1 }), n);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const x = (rnd() - 0.5) * 2600;
      const z = FAR_BANK_Z - 8 - rnd() * 22;
      const h = 4 + rnd() * 5;
      const r = 2 + rnd() * 2.2;
      m.compose(new THREE.Vector3(x, 1 + h + r * 0.5, z), new THREE.Quaternion(), new THREE.Vector3(r * 1.1, r, r * 1.1));
      crowns.setMatrixAt(i, m);
      crowns.setColorAt(i, c.set('#ffffff').offsetHSL(0, 0, (rnd() - 0.5) * 0.15));
      m.compose(new THREE.Vector3(x, 1 + h / 2, z), new THREE.Quaternion(), new THREE.Vector3(1, h, 1));
      trunks.setMatrixAt(i, m);
    }
    crowns.castShadow = this.q.shadows;
    this.group.add(crowns, trunks);
  }

  private addGrandstand(rnd: () => number) {
    const concrete = new THREE.MeshStandardMaterial({ color: '#a6abaf', roughness: 0.9 });
    const darkConcrete = new THREE.MeshStandardMaterial({ color: '#5c6166', roughness: 0.9 });
    const seats = seatTexture();
    seats.repeat.set(STAND_HALF / 4, 3);
    const seatMat = new THREE.MeshStandardMaterial({ map: seats, roughness: 0.85 });
    const Y = 1.2;
    const X = STAND_X;
    const tier = (z0: number, z1: number, y0: number, y1: number) => {
      const g = new THREE.PlaneGeometry(STAND_HALF * 2, Math.hypot(z1 - z0, y1 - y0));
      const m = new THREE.Mesh(g, seatMat);
      m.position.set(X, Y + (y0 + y1) / 2, (z0 + z1) / 2);
      m.rotation.x = -Math.PI / 2 + Math.atan2(y1 - y0, z1 - z0);
      m.receiveShadow = true;
      this.group.add(m);
      const fillM = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2, y1 - 0.5, z1 - z0), darkConcrete);
      fillM.position.set(X, Y + (y1 - 0.5) / 2, (z0 + z1) / 2 + 0.6);
      fillM.scale.y = 0.98;
      this.group.add(fillM);
    };
    tier(STAND_Z, STAND_Z + 12, 1.0, 6.5);
    tier(STAND_Z + 16, STAND_Z + 28, 9, 18);
    const facade = facadeTexture();
    facade.repeat.set(10, 2);
    this.windowMat.map = facade;
    const building = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2 + 20, 28, 18), [concrete, concrete, concrete, concrete, this.windowMat, concrete]);
    building.position.set(X, Y + 14, STAND_Z + 38);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2 + 10, 0.7, 34), concrete);
    roof.position.set(X, Y + 27, STAND_Z + 18);
    roof.rotation.x = -0.03;
    roof.castShadow = this.q.shadows;
    this.group.add(building, roof);
    const beams: THREE.BufferGeometry[] = [];
    for (let x = -STAND_HALF; x <= STAND_HALF; x += 15) {
      beams.push(new THREE.BoxGeometry(0.5, 1.4, 32).translate(X + x, Y + 26, STAND_Z + 18));
    }
    this.group.add(new THREE.Mesh(mergeGeometries(beams), new THREE.MeshStandardMaterial({ color: '#8d9399', roughness: 0.6, metalness: 0.3 })));
    for (const s of [-1, 1]) {
      const end = new THREE.Mesh(new THREE.BoxGeometry(2, 24, 34), concrete);
      end.position.set(X + s * (STAND_HALF + 1), Y + 12, STAND_Z + 16);
      this.group.add(end);
    }
    // 付属棟（スタンドの両脇・裏。規模と配置は推定）
    for (let i = 0; i < 6; i++) {
      const w = 20 + rnd() * 26;
      const h = 8 + rnd() * 12;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 16), i % 2 ? concrete : darkConcrete);
      const side = i < 3 ? -1 : 1;
      b.position.set(X + side * (STAND_HALF + 30 + (i % 3) * 40), Y + h / 2, STAND_Z + 20 + rnd() * 30);
      this.group.add(b);
    }
    // 照明柱（夕方に点灯。スタンド前のエプロン）
    const steel = new THREE.MeshStandardMaterial({ color: '#7b838a', metalness: 0.5, roughness: 0.5 });
    const glow = glowSprite();
    for (let i = 0; i < 6; i++) {
      const x = X - STAND_HALF + 20 + (i * (STAND_HALF * 2 - 40)) / 5;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 26, 8), steel);
      pole.position.set(x, Y + 13, STAND_BANK_Z + 5);
      const head = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 0.6), this.lampMat);
      head.position.set(x, Y + 26.5, STAND_BANK_Z + 4.6);
      this.group.add(pole, head);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: '#fff6e0', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      sp.position.set(x, Y + 26.5, STAND_BANK_Z + 3.8);
      sp.scale.set(12, 9, 1);
      this.glows.push(sp);
      this.group.add(sp);
    }
  }

  private addCrowd(rnd: () => number) {
    const n = this.q.crowd;
    const bodyGeo = new THREE.CapsuleGeometry(0.19, 0.62, 2, 6);
    bodyGeo.translate(0, 0.5, 0);
    const headGeo = new THREE.SphereGeometry(0.11, 7, 5);
    headGeo.translate(0, 1.18, 0);
    const bodies = new THREE.InstancedMesh(bodyGeo, crowdMaterial(this.crowdUniforms), n);
    const heads = new THREE.InstancedMesh(headGeo, crowdMaterial(this.crowdUniforms), n);
    const shirts = ['#e8e6e1', '#2d2f33', '#3c5a7d', '#7a2f2f', '#c8b27a', '#56704f', '#f0ece4', '#6a5a7a', '#c77a3a', '#1f3b5a', '#9aa3ab', '#b5463a'];
    const skins = ['#e0b896', '#c99a7a', '#a87656', '#f0cfb0', '#7d5236'];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const Y = 1.2;
    for (let i = 0; i < n; i++) {
      const r = rnd();
      let x: number;
      let y: number;
      let z: number;
      let scale = 1;
      if (r < 0.45) {
        x = STAND_X + (rnd() * 2 - 1) * (STAND_HALF - 2);
        z = STAND_Z + 0.5 + rnd() * 11;
        y = Y + 1.0 + (5.5 * (z - STAND_Z)) / 12 - 0.25;
        scale = 0.78;
      } else if (r < 0.65) {
        x = STAND_X + (rnd() * 2 - 1) * (STAND_HALF - 2);
        z = STAND_Z + 16.5 + rnd() * 11;
        y = Y + 9 + (9 * (z - STAND_Z - 16)) / 12 - 0.25;
        scale = 0.78;
      } else {
        // 水際のエプロンの立ち見（スタートラインと1マークの周りほど密）
        x = rnd() < 0.5 ? START_X + (rnd() - 0.3) * 150 : STAND_X + (rnd() * 2 - 1) * STAND_HALF;
        z = STAND_BANK_Z + 2.5 + rnd() * 6;
        y = Y + 0.02;
      }
      s.set(scale * (0.9 + rnd() * 0.2), scale * (0.9 + rnd() * 0.25), scale);
      q.setFromAxisAngle(yAxis, Math.PI + (rnd() - 0.5) * 0.8);
      m.compose(new THREE.Vector3(x, y, z), q, s);
      bodies.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
      bodies.setColorAt(i, c.set(shirts[Math.floor(rnd() * shirts.length)]).offsetHSL(0, 0, (rnd() - 0.5) * 0.1));
      heads.setColorAt(i, c.set(skins[Math.floor(rnd() * skins.length)]));
    }
    this.group.add(bodies, heads);
  }

  /** 横ピット：スタンド側の岸に沿った浮き桟橋と屋根（規模・位置は推定） */
  private addPit() {
    const deck = new THREE.MeshStandardMaterial({ color: '#7d756a', roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: '#d9dcdf', roughness: 0.6 });
    const steel = new THREE.MeshStandardMaterial({ color: '#6f777e', roughness: 0.5, metalness: 0.4 });
    const len = 70;
    const pontoon = new THREE.Mesh(new THREE.BoxGeometry(len, 0.6, 7), deck);
    pontoon.position.set(PIT_X, 0.2, STAND_BANK_Z - 3.5);
    pontoon.receiveShadow = true;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(len, 0.3, 8), roofMat);
    roof.position.set(PIT_X, 4.2, STAND_BANK_Z - 3);
    roof.castShadow = this.q.shadows;
    this.group.add(pontoon, roof);
    for (let i = 0; i <= 6; i++) {
      const x = PIT_X - len / 2 + (i * len) / 6;
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.25, 4, 0.25), steel);
      col.position.set(x, 2.3, STAND_BANK_Z - 0.6);
      // 係留の仕切り
      const div = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.5, 4), steel);
      div.position.set(x, 0.4, STAND_BANK_Z - 9);
      this.group.add(col, div);
    }
  }

  /** ターンマーク・コースの外側のブイ・スタートラインの標識 */
  private addCourseMarks(big: boolean) {
    const orange = new THREE.MeshStandardMaterial({ color: '#ff6a10', roughness: 0.45 });
    const white = new THREE.MeshStandardMaterial({ color: '#f4f4f0', roughness: 0.45 });
    const red = new THREE.MeshStandardMaterial({ color: '#c62828', roughness: 0.5 });
    // ターンマーク（円筒形の浮標。形は一般的なものを簡略化）
    for (const mk of [MARK_1, MARK_2]) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.85, 1.6, big ? 24 : 12), orange);
      body.position.y = 0.5;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.77, 0.77, 0.3, big ? 24 : 12), white);
      band.position.y = 0.8;
      const top = new THREE.Mesh(new THREE.ConeGeometry(0.75, 0.6, big ? 24 : 12), orange);
      top.position.y = 1.6;
      g.add(body, band, top);
      g.position.set(mk.x, 0, mk.z);
      g.traverse((o) => ((o as THREE.Mesh).castShadow = this.q.shadows));
      this.group.add(g);
    }
    // コースの外側を示すブイ（1マーク付近は幅が狭い）
    const buoyGeo = new THREE.SphereGeometry(0.35, 10, 6);
    const pts: THREE.Vector3[] = [];
    const outer = (s: number) => {
      const u = ((s % 600) + 600) % 600;
      const near1M = Math.abs(u - SEGMENTS.turn1Start) < 60 || (u >= SEGMENTS.turn1Start && u < SEGMENTS.turn1End);
      return near1M ? WIDTH_AT_1M : WIDTH;
    };
    for (let s = 0; s < 600; s += 6) {
      const p = pointAt(s, outer(s) + 1);
      pts.push(new THREE.Vector3(p.x, 0.12, p.z));
    }
    // 助走の区間（2マークの外側からスタートラインの手前）
    for (let s = -150; s < 0; s += 6) {
      const p = pointAt(s, WIDTH + 1);
      pts.push(new THREE.Vector3(p.x, 0.12, p.z));
    }
    const buoys = new THREE.InstancedMesh(buoyGeo, white, pts.length);
    const m = new THREE.Matrix4();
    pts.forEach((p, i) => {
      m.makeTranslation(p.x, p.y, p.z);
      buoys.setMatrixAt(i, m);
      buoys.setColorAt(i, new THREE.Color(i % 2 ? '#ffffff' : '#ff7a20'));
    });
    this.group.add(buoys);
    // スタートライン（＝ゴールライン）の標識：スタンド側の岸と水上の2か所
    const pole = new THREE.CylinderGeometry(0.12, 0.12, 9, 8);
    for (const z of [STAND_BANK_Z - 0.5, -R0 + 6]) {
      const p = new THREE.Mesh(pole, white);
      p.position.set(START_X, 4.5, z);
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.2, 1.6), red);
      board.position.set(START_X, 8.2, z);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.5, 1.62), white);
      stripe.position.set(START_X, 8.2, z);
      const float = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.6, 12), white);
      float.position.set(START_X, 0.1, z);
      this.group.add(p, board, stripe, float);
    }
  }

  /** 大時計：12秒で1周する針。スタート合図の瞬間に針が真上（0秒）を指す */
  private addClock() {
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: '#4d555c', roughness: 0.5, metalness: 0.4 });
    const face = new THREE.Mesh(new THREE.CircleGeometry(4.5, 48), new THREE.MeshBasicMaterial({ map: clockFaceTexture() }));
    face.position.y = 12;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.25, 8, 48), steel);
    rim.position.y = 12;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(11, 11, 0.6), steel);
    frame.position.set(0, 12, -0.4);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(1.2, 7, 1.2), steel);
    legs.position.set(0, 3.5, -0.4);
    const pontoon = new THREE.Mesh(new THREE.BoxGeometry(8, 0.8, 5), new THREE.MeshStandardMaterial({ color: '#8a8f93', roughness: 0.9 }));
    pontoon.position.set(0, 0.2, -0.4);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.35, 4.0, 0.08), new THREE.MeshBasicMaterial({ color: '#d32f2f' }));
    hand.position.y = 1.8;
    this.clockHand.add(hand);
    this.clockHand.position.set(0, 12, 0.08);
    g.add(face, rim, frame, legs, pontoon, this.clockHand);
    g.position.copy(CLOCK_POS);
    // 助走してくる艇（2マーク側）とスタンドの両方から見える向き
    g.lookAt(START_X - 60, 0, R0 + 30);
    this.group.add(g);
  }

  /** 対岸の街並み・遠景・橋（配置は推定の一般的な河川の風景） */
  private addFarSide(rnd: () => number) {
    const houses: THREE.BufferGeometry[] = [];
    const roofs: THREE.BufferGeometry[] = [];
    const flats: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 420; i++) {
      const x = (rnd() - 0.5) * 2400;
      const z = FAR_BANK_Z - 70 - rnd() * 420;
      const base = 4;
      if (rnd() < 0.82) {
        const w = 7 + rnd() * 5;
        const d = 7 + rnd() * 4;
        const h = 5 + rnd() * 3;
        const rot = rnd() * Math.PI;
        houses.push(new THREE.BoxGeometry(w, h, d).rotateY(rot).translate(x, base + h / 2, z));
        roofs.push(new THREE.ConeGeometry(Math.max(w, d) * 0.72, 2.2, 4).rotateY(Math.PI / 4 + rot).translate(x, base + h + 1.1, z));
      } else {
        const w = 18 + rnd() * 25;
        const h = 12 + rnd() * 30;
        flats.push(new THREE.BoxGeometry(w, h, 12 + rnd() * 8).rotateY(rnd() * 0.4).translate(x, base + h / 2, z));
      }
    }
    if (houses.length) this.group.add(new THREE.Mesh(mergeGeometries(houses), new THREE.MeshStandardMaterial({ color: '#d8d2c4', roughness: 0.95 })));
    if (roofs.length) this.group.add(new THREE.Mesh(mergeGeometries(roofs), new THREE.MeshStandardMaterial({ color: '#5a5e66', roughness: 0.8 })));
    if (flats.length) this.group.add(new THREE.Mesh(mergeGeometries(flats), new THREE.MeshStandardMaterial({ color: '#b8bcc0', roughness: 0.9 })));
    // スタンド側の背後の街
    const behind: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 160; i++) {
      const x = (rnd() - 0.5) * 2400;
      const z = STAND_Z + 90 + rnd() * 500;
      if (Math.abs(x - STAND_X) < STAND_HALF + 120 && z < STAND_Z + 140) continue;
      const h = 8 + rnd() * rnd() * 40;
      behind.push(new THREE.BoxGeometry(14 + rnd() * 30, h, 14 + rnd() * 20).translate(x, 1.2 + h / 2, z));
    }
    this.group.add(new THREE.Mesh(mergeGeometries(behind), new THREE.MeshStandardMaterial({ color: '#c3c6c9', roughness: 0.9 })));
    // 遠景の街並み
    const town: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 160; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 1300 + rnd() * 900;
      const h = 8 + rnd() * rnd() * 70;
      town.push(new THREE.BoxGeometry(20 + rnd() * 40, h, 20 + rnd() * 30).translate(Math.cos(a) * r, 2 + h / 2, Math.sin(a) * r));
    }
    this.group.add(new THREE.Mesh(mergeGeometries(town), new THREE.MeshLambertMaterial({ color: '#a4abb2' })));
    // 下流の橋（一般的な桁橋）
    const bridgeMat = new THREE.MeshStandardMaterial({ color: '#9ba1a6', roughness: 0.8 });
    const bx = MARK_2.x - 650;
    const deckG = new THREE.BoxGeometry(18, 2.2, STAND_BANK_Z - FAR_BANK_Z + 120);
    const bridge = new THREE.Mesh(deckG, bridgeMat);
    bridge.position.set(bx, 12, (STAND_BANK_Z + FAR_BANK_Z) / 2);
    this.group.add(bridge);
    for (let z = FAR_BANK_Z + 20; z < STAND_BANK_Z; z += 55) {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(5, 12, 3), bridgeMat);
      pier.position.set(bx, 5.5, z);
      this.group.add(pier);
    }
  }

  /** 吹き流し（スタンドの屋上。風速で伸び、風向きに流れる） */
  private addFlags() {
    const mat = new THREE.MeshStandardMaterial({ color: '#e53935', roughness: 0.7, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.flagUniforms.uTime;
      sh.uniforms.uWind = this.flagUniforms.uWind;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWind;').replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float u = position.x / 3.0;
         float strength = clamp(abs(uWind) / 6.0, 0.15, 1.0);
         transformed.x *= strength;
         transformed.y -= u * u * (1.0 - strength) * 2.2;
         transformed.z += sin(uTime * (3.0 + abs(uWind)) - u * 6.0) * 0.25 * u;`,
      );
    };
    const steel = new THREE.MeshStandardMaterial({ color: '#c8ccd0', roughness: 0.4, metalness: 0.5 });
    for (let i = 0; i < 3; i++) {
      const x = STAND_X - 60 + i * 60;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 8, 6), steel);
      pole.position.set(x, 1.2 + 27 + 4, STAND_Z + 26);
      const geo = new THREE.PlaneGeometry(3, 0.9, 12, 1).translate(1.5, 0, 0);
      const flag = new THREE.Mesh(geo, mat);
      flag.position.set(x, 1.2 + 27 + 7.4, STAND_Z + 26);
      this.flags.push(flag);
      this.group.add(pole, flag);
    }
  }

  /** 天候・時間帯・潮・風・波に合わせて空・光・霧・水面を切り替える */
  applyConditions(weather: Weather, timeOfDay: TimeOfDay, tide: Tide, wind: number, wave: number, boardLines: string[]) {
    const overcast = weather === 'rain' ? 1 : weather === 'cloudy' ? 0.55 : 0.15;
    const u = this.sky.material.uniforms;
    let elevation: number;
    let azimuth: number;
    let fogColor: string;
    let fogDensity: number;
    let sunColor: string;
    let sunI: number;
    let envI: number;
    let cloudTint: string;
    if (timeOfDay === 'night') {
      elevation = -6;
      azimuth = 200;
      u.turbidity.value = 2;
      u.rayleigh.value = 0.2;
      fogColor = '#0d1522';
      fogDensity = 0.0007;
      sunColor = '#e6eeff';
      sunI = 2.6;
      envI = 0.12;
      cloudTint = '#2a3240';
    } else if (timeOfDay === 'dusk') {
      elevation = 5;
      azimuth = 250;
      u.turbidity.value = 5 + overcast * 6;
      u.rayleigh.value = 2.4 - overcast;
      fogColor = '#c49a7a';
      fogDensity = 0.0005 + overcast * 0.0004;
      sunColor = '#ffb27a';
      sunI = 2.4 * (1 - overcast * 0.6);
      envI = 0.75;
      cloudTint = '#e7b08f';
    } else {
      elevation = 40;
      azimuth = 200;
      u.turbidity.value = 3 + overcast * 14;
      u.rayleigh.value = 1.3 - overcast * 0.9;
      fogColor = overcast > 0.7 ? '#9aa3aa' : overcast > 0.4 ? '#b6c2cb' : '#c5d6e2';
      fogDensity = 0.0003 + overcast * 0.0007;
      sunColor = overcast > 0.5 ? '#eef1f3' : '#fff2df';
      sunI = 3.4 * (1 - overcast * 0.75);
      envI = 1.0;
      cloudTint = overcast > 0.7 ? '#a7adb2' : '#f4f6f8';
    }
    u.mieCoefficient.value = 0.004 + overcast * 0.01;
    u.mieDirectionalG.value = 0.8;
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);

    this.cloudTex = cloudTexture(this.cloudData, 512, 256, overcast, cloudTint, this.cloudTex ?? undefined);
    this.clouds.material.map = this.cloudTex;
    this.clouds.material.needsUpdate = true;

    // 空から環境光（IBL）を作る（水面の映り込みにも使う）
    const envScene = new THREE.Scene();
    const skyClone = new Sky();
    skyClone.scale.setScalar(1000);
    skyClone.material.uniforms = THREE.UniformsUtils.clone(u);
    envScene.add(skyClone);
    if (timeOfDay === 'night') envScene.background = new THREE.Color('#0a1220');
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(envScene, 0.02, 1, 3000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = envI * (1 - overcast * 0.25);
    skyClone.geometry.dispose();
    skyClone.material.dispose();
    this.scene.background = timeOfDay === 'night' ? new THREE.Color('#070c16') : null;
    this.sky.visible = timeOfDay !== 'night';
    this.scene.fog = new THREE.FogExp2(fogColor, fogDensity);

    this.fill.intensity = timeOfDay === 'night' ? 0.9 : 0;
    this.hemi.intensity = 0.15 + overcast * 0.25;
    this.hemi.color.set(fogColor);
    this.sun.color.set(sunColor);
    this.sun.intensity = sunI;
    this.focusShadow(0, R0, this.shadowRadius);

    const lit = timeOfDay !== 'day';
    this.lampMat.emissive.set(lit ? '#fff6e6' : '#000000');
    this.lampMat.emissiveIntensity = lit ? 3 : 0;
    this.glows.forEach((g) => (g.material.opacity = timeOfDay === 'night' ? 0.28 : timeOfDay === 'dusk' ? 0.14 : 0));
    this.windowMat.emissive.set(timeOfDay === 'night' ? '#e8c27a' : timeOfDay === 'dusk' ? '#5a4a30' : '#000000');
    this.windowMat.emissiveIntensity = timeOfDay === 'night' ? 0.6 : 0.3;

    // 水面：波が高いほど凹凸が強く、ざらついた反射に。雨の日は濁った色
    const k = Math.min(1, wave / 10);
    this.waterMat.normalScale.set(0.06 + k * 0.3, 0.06 + k * 0.3);
    this.waterMat.roughness = 0.2 + k * 0.12 + (weather === 'rain' ? 0.08 : 0);
    this.waterMat.color.set(weather === 'rain' ? '#2c3a39' : timeOfDay === 'dusk' ? '#283a3e' : '#1f3a3f');
    // 河川の水は空を映しすぎない（映り込みの強さを抑える）
    this.waterMat.envMapIntensity = 0.45;
    // 潮の流れ：上げ潮は上流（-x）へ、下げ潮は下流（+x）へ水面の模様が流れる
    const flow = tide === 'rising' ? -0.004 : tide === 'falling' ? 0.004 : 0;
    this.waterFlow.value.set(flow, 0);
    this.flagUniforms.uWind.value = wind;
    this.flags.forEach((f) => (f.rotation.y = wind >= 0 ? 0 : Math.PI));

    this.board.material.map?.dispose();
    this.board.material.map = boardTexture(boardLines);
    this.board.material.needsUpdate = true;
  }

  /** 影の範囲を注目地点の周りに限定する（radius は画角から決める） */
  focusShadow(x: number, z: number, radius = this.shadowRadius) {
    this.shadowRadius = radius;
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x + this.sunDir.x * 500, this.sunDir.y * 500, z + this.sunDir.z * 500);
    if (this.sun.castShadow) {
      const s = this.sun.shadow.camera;
      const r = Math.max(25, Math.min(160, radius));
      if (Math.abs(s.right - r) > 2) {
        s.left = s.bottom = -r;
        s.right = s.top = r;
        s.updateProjectionMatrix();
      }
    }
    this.fill.target.position.set(x, 0, z);
  }

  setShadows(on: boolean) {
    this.sun.castShadow = on && this.q.shadows;
  }

  /**
   * 毎フレームの更新。
   * @param wallTime 実時間（水面・旗・観客の揺れ）
   * @param raceTime 映像の時刻（大時計の針）
   */
  update(wallTime: number, raceTime: number, excitement: number) {
    this.crowdUniforms.uTime.value = wallTime;
    this.crowdUniforms.uExcite.value += (excitement - this.crowdUniforms.uExcite.value) * 0.05;
    this.clouds.rotation.y = wallTime * 0.002;
    this.waterTime.value = wallTime;
    this.flagUniforms.uTime.value = wallTime;
    // 大時計：スタート合図（raceTime = LEAD）で真上。合図の後は止まる
    const tc = Math.min(raceTime, LEAD + 1) - LEAD;
    this.clockHand.rotation.z = -(tc / 12) * Math.PI * 2;
  }

  dispose() {
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const mat of mats) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
        mat.dispose();
      }
    });
  }
}
