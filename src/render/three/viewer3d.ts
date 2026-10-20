/**
 * three.js による3D観戦ビューア（RaceViewer の実装）。
 *
 * 画質：
 * - 低（軽量）：影なし・簡略モデル・しぶきと泡を少なめ・ポストプロセスなし。スマートフォン向け
 * - 中：影あり・標準モデル
 * - 高：高解像度の影・詳細モデル・モーションブラー・被写界深度
 * - 自動：タッチ端末は低、それ以外は中から開始し、FPS が低ければ段階的に下げる
 *
 * 映像は走行ログを再生するだけで、結果には影響しない。
 */
import * as THREE from 'three';
import { pointAt } from '../../core/course';
import type { RaceCard } from '../../core/meeting';
import { LEAD, type SimResult, TIDE_LABEL } from '../../core/sim';
import { BOAT_COLORS } from '../../data/racers';
import type { BoatFrame, CameraMode, RaceViewer } from '../types';
import { BoatModel, type Detail } from './boatModel';
import { CameraDirector, type DirectorBoat } from './camera';
import { DustSystem, FoamTrail, RainSystem } from './effects';
import { Environment } from './environment';
import { PostFX } from './post';

export type Quality = 'auto' | 'low' | 'medium' | 'high';
type Level = 'low' | 'medium' | 'high';

interface Profile {
  pixelRatio: number;
  antialias: boolean;
  shadows: boolean;
  shadowSize: number;
  crowd: number;
  trees: number;
  detail: Detail;
  spray: number;
  foam: number;
  rain: number;
  post: boolean;
}

const PROFILES: Record<Level, Profile> = {
  low: { pixelRatio: 1, antialias: false, shadows: false, shadowSize: 0, crowd: 1500, trees: 160, detail: 'low', spray: 600, foam: 900, rain: 600, post: false },
  medium: { pixelRatio: 1.5, antialias: true, shadows: true, shadowSize: 2048, crowd: 4500, trees: 320, detail: 'medium', spray: 1800, foam: 2200, rain: 1200, post: false },
  high: { pixelRatio: 2, antialias: false, shadows: true, shadowSize: 4096, crowd: 9000, trees: 600, detail: 'high', spray: 3500, foam: 3600, rain: 2000, post: true },
};

export interface Viewer3DOptions {
  quality: Quality;
  reducedMotion: boolean;
  onFail: (reason: string) => void;
  onQualityChange?: (label: string) => void;
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

export class Viewer3D implements RaceViewer {
  readonly kind = '3d' as const;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 16 / 9, 1.0, 6000);
  private director = new CameraDirector(this.camera);
  private env!: Environment;
  private spray!: DustSystem;
  private foam!: FoamTrail;
  private rain!: RainSystem;
  private post: PostFX | null = null;
  private boats: BoatModel[] = [];
  private foamClock: number[] = [];
  private container: HTMLElement | null = null;
  private card: RaceCard | null = null;
  private level: Level;
  private profile: Profile;
  private pixelRatio: number;
  private emitScale = 1;
  private waveM = 0.03;
  private lastTime = 0;
  private lastWall = 0;
  private followIndex = 0;
  private fpsFrames = 0;
  private fpsStart = 0;
  private downgrades = 0;
  private failed = false;
  private sprayColor = new THREE.Color('#f2f6f8');
  private lastShot = '';
  private width = 1;
  private height = 1;

  /** 開発時の確認用：カメラの状態 */
  debugInfo() {
    const c = this.camera;
    return { shot: this.director.shot, fov: c.fov, pos: c.position.toArray().map((v) => Math.round(v)), look: this.director.lookPoint.toArray().map((v) => Math.round(v)), radius: this.director.subjectRadius };
  }

  constructor(private opts: Viewer3DOptions) {
    if (import.meta.env.DEV) (window as unknown as { __viewer3d: Viewer3D }).__viewer3d = this;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.level = opts.quality === 'auto' ? (coarse ? 'low' : 'medium') : opts.quality;
    this.profile = PROFILES[this.level];
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.profile.pixelRatio);
    this.director.reducedMotion = opts.reducedMotion;
  }

  mount(container: HTMLElement): void {
    this.container = container;
    const p = this.profile;
    this.renderer = new THREE.WebGLRenderer({ antialias: p.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = p.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    const canvas = this.renderer.domElement;
    canvas.className = 'viewer-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '3Dのレース映像。順位と周回は画面上の表示と実況タブでも確認できます');
    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.fail('WebGL のコンテキストが失われました');
    });
    container.appendChild(canvas);

    this.env = new Environment(this.scene, this.renderer, { level: this.level, crowd: p.crowd, trees: p.trees, shadows: p.shadows, shadowSize: p.shadowSize });
    this.spray = new DustSystem(p.spray);
    this.spray.gravity = 9.8;
    this.spray.drag = 0.6;
    this.spray.growth = 1.2;
    this.spray.opacity = 0.75;
    this.foam = new FoamTrail(p.foam);
    this.rain = new RainSystem(p.rain);
    this.scene.add(this.spray.points, this.foam.mesh, this.rain.lines);
    this.resize();
    if (p.post) {
      try {
        this.post = new PostFX(this.renderer, this.scene, this.camera, this.width, this.height);
      } catch (e) {
        console.warn('post-processing disabled', e);
        this.post = null;
      }
    }
  }

  private fail(reason: string) {
    if (this.failed) return;
    this.failed = true;
    this.opts.onFail(reason);
  }

  setRace(card: RaceCard, _result: SimResult | null): void {
    if (this.card?.id === card.id && this.boats.length) return;
    this.card = card;
    const c = card.conditions;
    this.boats.forEach((b) => {
      this.scene.remove(b.root);
      b.dispose();
    });
    this.boats = card.entries.map((e) => {
      const col = BOAT_COLORS[(e.number - 1) % 6];
      const m = new BoatModel({ number: e.number, color: col.bg, fg: col.fg }, this.profile.detail, { shadows: this.profile.shadows });
      this.scene.add(m.root);
      return m;
    });
    this.foamClock = card.entries.map(() => 0);
    this.env.applyConditions(c.weather, c.timeOfDay, c.tide, c.wind, c.wave, [`${card.no}R ${card.name}`, `${TIDE_LABEL[c.tide]} 波${c.wave}cm`]);
    this.rain.setIntensity(c.weather === 'rain' ? 2 : 0);
    this.waveM = Math.max(0.02, c.wave / 100);
    const s = this.env.sun;
    const light = s.color.clone().multiplyScalar(Math.min(1.15, 0.45 + s.intensity * 0.2));
    this.spray.setLight(light);
    // 泡は白く（太陽の色味は控えめに）
    const foamLight = new THREE.Color(1, 1, 1).lerp(s.color, 0.25).multiplyScalar(Math.min(1, 0.5 + s.intensity * 0.18));
    this.foam.setLight(foamLight);
    this.spray.clear();
    this.foam.clear();
    this.lastTime = 0;
  }

  setCamera(mode: CameraMode, followIndex?: number): void {
    this.director.mode = mode;
    this.followIndex = followIndex ?? this.followIndex;
  }

  setQuality(q: Quality) {
    const level: Level = q === 'auto' ? this.level : q;
    const p = PROFILES[level];
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, p.pixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = p.shadows && this.profile.shadows;
    this.env.setShadows(p.shadows);
    this.emitScale = level === 'low' ? 0.5 : 1;
    if (!p.post && this.post) {
      this.post.dispose();
      this.post = null;
    } else if (p.post && !this.post) {
      try {
        this.post = new PostFX(this.renderer, this.scene, this.camera, this.width, this.height);
      } catch {
        this.post = null;
      }
    }
    this.opts.quality = q;
    this.resize();
  }

  resize(): void {
    if (!this.container || !this.renderer) return;
    this.width = Math.max(1, this.container.clientWidth);
    this.height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.domElement.style.width = `${this.width}px`;
    this.renderer.domElement.style.height = `${this.height}px`;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.spray.setViewportHeight(this.height * this.pixelRatio);
    this.post?.setSize(this.width, this.height);
  }

  render(time: number, frames: BoatFrame[]): void {
    if (this.failed || !this.card) return;
    const wall = performance.now();
    const dtWall = this.lastWall ? Math.min(0.1, (wall - this.lastWall) / 1000) : 0.016;
    this.lastWall = wall;
    let dtRace = time - this.lastTime;
    if (dtRace < 0 || dtRace > 1) {
      // シーク：演出をリセット
      this.spray.clear();
      this.foam.clear();
      this.post?.resetHistory();
      dtRace = 0;
    }
    this.lastTime = time;

    const inputs: DirectorBoat[] = [];
    const wallSec = wall / 1000;
    frames.forEach((f, i) => {
      const m = this.boats[i];
      if (!m) return;
      const p = pointAt(f.x, f.lane);
      m.update(p.x, p.z, p.heading, f.v, dtRace, wallSec, this.waveM);
      m.setHighlight(this.director.mode === 'follow' && i === this.followIndex);
      inputs.push({ x: f.x, wx: p.x, wz: p.z, heading: p.heading, v: f.v, rank: f.rank, out: f.out, finished: f.finished });
      if (dtRace > 0) this.waterFx(i, m, p.heading, f.v, p.onTurn, dtRace);
    });

    this.director.update({ time, dt: dtRace > 0 ? dtRace : dtWall * 0.5, boats: inputs, followIndex: this.followIndex, aspect: this.width / this.height });
    if (this.director.shot !== this.lastShot) {
      this.post?.resetHistory();
      this.lastShot = this.director.shot;
    }
    this.env.focusShadow(this.director.focus.x, this.director.focus.z, this.director.subjectRadius * 1.5 + 10);
    const finishing = frames.some((f) => f.finished) || (time > LEAD && frames.some((f) => f.x > 1650));
    this.env.update(wallSec, time, finishing ? 1 : time > LEAD - 1 && time < LEAD + 6 ? 0.6 : 0.15);
    const fxDt = dtRace > 0 ? dtWall : 0;
    this.spray.update(fxDt);
    this.foam.update(fxDt);
    this.rain.update(dtWall, this.camera.position.clone().lerp(this.director.focus, 0.6));

    try {
      if (this.post) this.post.render(dtWall, this.director.focusDistance);
      else this.renderer.render(this.scene, this.camera);
    } catch (e) {
      this.fail(String(e));
      return;
    }
    this.monitorFps(wall);
  }

  /** モーターの水しぶき（後方に立つ噴き上げ）と引き波の泡。ターンでは外側へ大きく飛ぶ */
  private waterFx(i: number, m: BoatModel, heading: number, v: number, onTurn: boolean, dt: number) {
    if (v < 2) return;
    const fx = Math.cos(heading);
    const fz = Math.sin(heading);
    const k = this.emitScale * Math.min(1, v / 18);
    const st = m.stern;
    // 噴き上げ（速度に比例。ターン中は多く、外側＝右側へ）
    const n = Math.round((onTurn ? 5 : 2.5) * k + Math.random());
    for (let q = 0; q < n; q++) {
      const out = onTurn ? 2.5 + Math.random() * 3 : (Math.random() - 0.5) * 1.6;
      // 左回りのターンの外側（進行方向に対して横向きのベクトル (-fz, fx)）
      const ox = -fz;
      const oz = fx;
      this.spray.emit(
        st.x + (Math.random() - 0.5) * 0.4,
        st.y,
        st.z + (Math.random() - 0.5) * 0.4,
        -fx * v * (0.25 + Math.random() * 0.2) + ox * out,
        2.5 + Math.random() * (onTurn ? 4 : 2.5),
        -fz * v * (0.25 + Math.random() * 0.2) + oz * out,
        0.6 + Math.random() * 0.6,
        0.35 + Math.random() * 0.5,
        this.sprayColor,
      );
    }
    // 引き波の泡：一定間隔で左右に置く
    this.foamClock[i] += dt;
    const every = 0.06 / Math.max(0.3, this.emitScale);
    while (this.foamClock[i] > every) {
      this.foamClock[i] -= every;
      for (const side of [-1, 1]) {
        this.foam.add(st.x - fz * side * 0.55, 0.03, st.z + fx * side * 0.55, heading, onTurn ? 1.4 : 1.0, onTurn ? 0.9 : 0.6, onTurn ? 9 : 7);
      }
    }
  }

  /** 自動画質：3秒平均が 30fps を下回ったら段階的に下げる（レースは最後まで表示を続ける） */
  private monitorFps(wall: number) {
    if (this.opts.quality !== 'auto') return;
    if (!this.fpsStart) this.fpsStart = wall;
    this.fpsFrames++;
    const span = wall - this.fpsStart;
    if (span < 3000) return;
    const fps = (this.fpsFrames * 1000) / span;
    this.fpsFrames = 0;
    this.fpsStart = wall;
    if (fps >= 30 || this.downgrades >= 4) return;
    this.downgrades++;
    if (this.post) {
      this.post.dispose();
      this.post = null;
    } else if (this.downgrades <= 2) {
      this.pixelRatio = Math.max(0.6, this.pixelRatio * 0.75);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.resize();
    } else if (this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.enabled = false;
      this.env.setShadows(false);
    } else {
      this.emitScale *= 0.4;
    }
    this.opts.onQualityChange?.(`自動調整 ${this.downgrades}/4`);
  }

  dispose(): void {
    // forceContextLoss が webglcontextlost を発火させるため、先に失敗扱いにして2Dへの切替を防ぐ
    this.failed = true;
    this.boats.forEach((b) => b.dispose());
    this.post?.dispose();
    this.spray?.dispose();
    this.foam?.dispose();
    this.rain?.dispose();
    this.env?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
    }
    this.container = null;
  }
}
