/**
 * 水面のコース形状。江戸川の公開情報（河川水面、1マーク付近の幅が狭く約37m、1マークがスタンド寄り、
 * 横ピット）を参考にした **非公式の再現**。寸法の多くは推定（docs/05-venue-reference.md）。
 *
 * - 1周 600m を3周（1,800m）。左回り（反時計回り）
 * - 2つのターンマーク（1マーク・2マーク）の周りを、内側の線（マークから R0 の円）に沿って回る
 * - s：スタートライン（＝ゴールライン）からの、内側の線に沿った距離
 * - d：内側の線から外側（スタンド側の直線では手前側）への横の距離 (m)
 *
 * 座標：x は右（スタンドから見て右が1マーク）、z は手前（スタンド側が +z）、y は上。
 */

export const LAP = 600;
export const LAPS = 3;
export const DISTANCE = LAP * LAPS;
/** 内側の線のターン半径（マークからの距離） */
export const R0 = 15;
/** マーク間（直線）の長さ */
export const STRAIGHT = LAP / 2 - Math.PI * R0;
/** スタートラインから1マークのターン入口までの距離（推定） */
export const START_TO_1M = 150;
/** 1マーク付近の水面の幅（内側の線から外側の岸までの目安。江戸川は約37m） */
export const WIDTH_AT_1M = 37;
/** 一般的な水面の幅（他の区間） */
export const WIDTH = 45;
/** スタートラインの x 座標 */
export const START_X = STRAIGHT / 2 - START_TO_1M;
/** 1マーク・2マークの位置 */
export const MARK_1 = { x: STRAIGHT / 2, z: 0 };
export const MARK_2 = { x: -STRAIGHT / 2, z: 0 };

/** ラップ内の区間の始まり（s：スタートラインからの距離、0〜600） */
export const SEGMENTS = {
  turn1Start: START_TO_1M,
  turn1End: START_TO_1M + Math.PI * R0,
  turn2Start: START_TO_1M + Math.PI * R0 + STRAIGHT,
  turn2End: START_TO_1M + 2 * Math.PI * R0 + STRAIGHT,
};

export interface WaterPoint {
  x: number;
  z: number;
  /** 進行方向（ラジアン、+x が 0、+z が +π/2） */
  heading: number;
  onTurn: boolean;
  /** 0: 1マーク、1: 2マーク、-1: 直線 */
  turnIndex: number;
}

export function lapPos(s: number): number {
  return ((s % LAP) + LAP) % LAP;
}

/** s, d から位置を求める（直線は d だけ外側へ、ターン中はマークを中心に半径 R0+d） */
export function pointAt(s: number, d: number): WaterPoint {
  // スタート前の助走（s < 0）はスタートラインの手前へ直線を延ばす
  if (s < 0) return { x: START_X + s, z: R0 + d, heading: 0, onTurn: false, turnIndex: -1 };
  const u = lapPos(s);
  const { turn1Start, turn1End, turn2Start, turn2End } = SEGMENTS;
  const R = R0 + d;
  if (u < turn1Start) {
    // ホームストレッチ（スタート後半）：+x へ
    return { x: START_X + u, z: R, heading: 0, onTurn: false, turnIndex: -1 };
  }
  if (u < turn1End) {
    // 1マーク：左回りで +z → -z へ（マークの右側を回る）
    const a = Math.PI / 2 - (u - turn1Start) / R0;
    return { x: MARK_1.x + Math.cos(a) * R, z: Math.sin(a) * R, heading: a - Math.PI / 2, onTurn: true, turnIndex: 0 };
  }
  if (u < turn2Start) {
    // バックストレッチ：-x へ
    return { x: MARK_1.x - (u - turn1End), z: -R, heading: Math.PI, onTurn: false, turnIndex: -1 };
  }
  if (u < turn2End) {
    const a = -Math.PI / 2 - (u - turn2Start) / R0;
    return { x: MARK_2.x + Math.cos(a) * R, z: Math.sin(a) * R, heading: a - Math.PI / 2, onTurn: true, turnIndex: 1 };
  }
  // ホームストレッチ（スタートライン手前）
  return { x: MARK_2.x + (u - turn2End), z: R, heading: 0, onTurn: false, turnIndex: -1 };
}

/** ターン中に横の位置 d を走るときの、内側の線に沿った進みの比率 */
export function progressFactor(s: number, d: number): number {
  return pointAt(s, 0).onTurn ? R0 / (R0 + d) : 1;
}

/** 区間ごとの水面の幅（1マーク付近は狭い） */
export function widthAt(s: number): number {
  const u = lapPos(s);
  const near1M = Math.abs(u - SEGMENTS.turn1Start) < 60 || (u >= SEGMENTS.turn1Start && u < SEGMENTS.turn1End);
  return near1M ? WIDTH_AT_1M : WIDTH;
}

/** 次のターン入口までの距離と、そのターンの通し番号（0:1周目1マーク、1:1周目2マーク…） */
export function nextTurn(s: number): { dist: number; index: number } {
  if (s < 0) return { dist: SEGMENTS.turn1Start - s, index: 0 };
  const lap = Math.floor(s / LAP);
  const u = lapPos(s);
  const { turn1Start, turn2Start } = SEGMENTS;
  if (u < turn1Start) return { dist: turn1Start - u, index: lap * 2 };
  if (u < turn2Start) return { dist: turn2Start - u, index: lap * 2 + 1 };
  return { dist: LAP - u + turn1Start, index: (lap + 1) * 2 };
}
