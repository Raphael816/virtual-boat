/**
 * 中継カメラの演出。スタンド側の高い位置からの望遠を基本に、レースの局面でカメラを切り替える。
 *
 * - スタート：スタートラインの真横（スタンド）から、待機行動〜スタートを全艇が入る画角で
 * - 1マーク／2マーク：マークの近くのスタンドから、ターンの攻防を寄りで
 * - 先頭追走：スタンド側のレールカメラが先頭集団を追う
 * - 注目艇：選んだ艇を後方上空から追う（ヘリ風）
 * - ゴール：ゴールラインの真横（岸）から、ライン上を横切る瞬間を
 * - 自動：先頭の位置から局面を判断して切り替える（短時間での切り替えはしない）
 *
 * 画角は被写体（先頭集団）の広がりに合わせて決める（望遠のオートフレーミング）。
 */
import * as THREE from 'three';
import { DISTANCE, MARK_1, MARK_2, R0, SEGMENTS, START_X, lapPos } from '../../core/course';
import { LEAD } from '../../core/sim';
import type { CameraMode } from '../types';
import { STAND_BANK_Z, STAND_X, STAND_Z } from './environment';

export type Shot = 'overview' | 'start' | 'turn1' | 'leaders' | 'turn2' | 'follow' | 'finish';

export interface DirectorBoat {
  /** 走行距離 s */
  x: number;
  wx: number;
  wz: number;
  heading: number;
  v: number;
  rank: number;
  out: boolean;
  finished: boolean;
}

export interface DirectorInput {
  time: number;
  dt: number;
  boats: DirectorBoat[];
  followIndex: number;
  aspect: number;
}

const MIN_SHOT = 2.5;
/** スタンド前（エプロンの立ち見の上、照明柱より水際）のカメラ位置 */
const CAM_Z = STAND_BANK_Z + 3;

export class CameraDirector {
  mode: CameraMode = 'auto';
  reducedMotion = false;
  shot: Shot = 'start';
  readonly focus = new THREE.Vector3();
  readonly lookPoint = new THREE.Vector3();
  subjectRadius = 20;
  focusDistance = 100;
  private pos = new THREE.Vector3(START_X, 20, STAND_Z + 40);
  private fov = 30;
  private shotStart = -Infinity;
  private railX = START_X;
  private snap = true;

  constructor(private camera: THREE.PerspectiveCamera) {}

  /** 自動のときの局面判断 */
  private autoShot(time: number, leadX: number, leaderFinished: boolean): Shot {
    if (leaderFinished) return 'finish';
    if (time < LEAD + 2.5 || leadX < 95) return 'start';
    const u = lapPos(leadX);
    if (leadX > DISTANCE - 150) return 'finish';
    if (u >= 95 && u < SEGMENTS.turn1End + 25) return 'turn1';
    if (u >= SEGMENTS.turn1End + 25 && u < SEGMENTS.turn2Start - 50) return 'leaders';
    if (u >= SEGMENTS.turn2Start - 50 && u < SEGMENTS.turn2End + 30) return 'turn2';
    return 'leaders';
  }

  update(inp: DirectorInput) {
    const { time, boats, aspect } = inp;
    const dt = Math.max(0, inp.dt);
    const racing = boats.filter((b) => !b.out);
    const pool = racing.length ? racing : boats;
    const sorted = [...pool].sort((a, b) => a.rank - b.rank);
    const leader = sorted[0];
    const leadX = leader ? leader.x : 0;

    // 被写体：スタート前後は全艇、それ以外は先頭から3艇（先頭を重めに）
    const subjects = time < LEAD + 4 ? pool : sorted.slice(0, 3);
    const c = new THREE.Vector3();
    let wsum = 0;
    subjects.forEach((b, i) => {
      const w = i === 0 ? 2 : 1;
      c.x += b.wx * w;
      c.z += b.wz * w;
      wsum += w;
    });
    if (wsum) c.divideScalar(wsum);
    let radius = 8;
    for (const b of subjects) radius = Math.max(radius, Math.hypot(b.wx - c.x, b.wz - c.z) + 5);
    // 離れすぎた後続は追わない（先頭の周り40mまで）
    radius = Math.min(radius, 40);

    // 局面
    let want: Shot;
    if (this.mode === 'auto') want = this.autoShot(time, leadX, !!leader?.finished);
    else if (this.mode === 'leaders') want = 'leaders';
    else want = this.mode as Shot;
    if (want !== this.shot && (this.mode !== 'auto' || time - this.shotStart > MIN_SHOT || time < this.shotStart)) {
      this.shot = want;
      this.shotStart = time;
      this.snap = true;
    }

    const target = new THREE.Vector3(c.x, 1, c.z);
    const camPos = new THREE.Vector3();
    let fixedFov: number | null = null;
    const follow = boats[inp.followIndex] ?? leader;
    switch (this.shot) {
      case 'overview':
        camPos.set(STAND_X - 20, 70, STAND_Z + 120);
        target.set(-10, 0, -10);
        fixedFov = aspect < 1 ? 62 : 40;
        radius = 160;
        break;
      case 'start':
        // スタートラインの真横・スタンド上段から
        camPos.set(START_X - 15, 20, CAM_Z);
        break;
      case 'turn1':
        camPos.set(MARK_1.x - 45, 22, CAM_Z);
        target.lerp(new THREE.Vector3(MARK_1.x, 1, MARK_1.z), 0.25);
        radius = Math.max(radius, 14);
        break;
      case 'turn2':
        camPos.set(MARK_2.x + 45, 22, CAM_Z);
        target.lerp(new THREE.Vector3(MARK_2.x, 1, MARK_2.z), 0.25);
        radius = Math.max(radius, 14);
        break;
      case 'leaders': {
        // レールカメラ：先頭の少し後ろの岸を、遅れて追う
        const dir = leader ? Math.cos(leader.heading) : 1;
        const want = Math.max(MARK_2.x - 30, Math.min(MARK_1.x + 30, c.x - dir * 30));
        this.railX += (want - this.railX) * (this.snap ? 1 : Math.min(1, dt * 0.8));
        camPos.set(this.railX, 24, CAM_Z);
        break;
      }
      case 'follow': {
        if (follow) {
          const hx = Math.cos(follow.heading);
          const hz = Math.sin(follow.heading);
          camPos.set(follow.wx - hx * 24 + hz * 6, 11, follow.wz - hz * 24 - hx * 6);
          target.set(follow.wx + hx * 10, 0.5, follow.wz + hz * 10);
          fixedFov = aspect < 1 ? 58 : 38;
          radius = 10;
        }
        break;
      }
      case 'finish':
                // 岸のライン標識（高さ約9m）より上から見下ろして、標識が画面を遮らないようにする
        camPos.set(START_X, 13, STAND_BANK_Z + 3);
        target.set(START_X, 0.5, Math.max(R0, c.z));
        fixedFov = aspect < 1 ? 38 : 24;
        break;
    }

    // 位置・注視点の平滑化（カットの瞬間はスナップ）
    const kPos = this.snap ? 1 : 1 - Math.exp(-dt * (this.reducedMotion ? 1.5 : 3));
    const kLook = this.snap ? 1 : 1 - Math.exp(-dt * (this.reducedMotion ? 2.5 : 6));
    this.pos.lerp(camPos, kPos);
    this.lookPoint.lerp(target, kLook);
    this.focus.copy(target);

    // 望遠のオートフレーミング：被写体の半径が画面の横幅に収まる画角
    const dist = this.pos.distanceTo(this.lookPoint);
    let fov: number;
    if (fixedFov !== null) fov = fixedFov;
    else {
      const half = Math.atan((radius * 1.25) / Math.max(1, dist));
      const vHalf = Math.atan(Math.tan(half) / Math.min(aspect, 1.8));
      fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(vHalf * 2), 5, 55);
    }
    this.fov += (fov - this.fov) * (this.snap ? 1 : 1 - Math.exp(-dt * 2.5));
    this.snap = false;

    this.camera.position.copy(this.pos);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.lookPoint);
    this.subjectRadius = radius;
    this.focusDistance = dist;
  }
}
