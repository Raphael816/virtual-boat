import type { RaceCard } from '../core/meeting';
import type { SimResult } from '../core/sim';

export interface BoatFrame {
  /** runner index */
  index: number;
  /** 艇番 */
  number: number;
  /** 走行距離 s（内側の線に沿った距離。スタート前は負） */
  x: number;
  lane: number;
  v: number;
  /** 現在の順位（1始まり） */
  rank: number;
  finished: boolean;
  /** フライング・出遅れで欠場 */
  out: boolean;
}

export type CameraMode = 'auto' | 'overview' | 'start' | 'turn1' | 'leaders' | 'turn2' | 'follow' | 'finish';

export const CAMERA_LABEL: Record<CameraMode, string> = {
  auto: '自動',
  overview: '全景',
  start: 'スタート',
  turn1: '1マーク',
  leaders: '先頭追走',
  turn2: '2マーク',
  follow: '注目艇',
  finish: 'ゴール',
};

/** 映像の描画部分。2D（Canvas）と3D（three.js）で差し替える */
export interface RaceViewer {
  readonly kind: '2d' | '3d';
  mount(container: HTMLElement): void;
  /** 出走表と走行ログ（発走前は null）を設定 */
  setRace(card: RaceCard, result: SimResult | null): void;
  render(time: number, boats: BoatFrame[]): void;
  setCamera?(mode: CameraMode, followIndex?: number): void;
  setQuality?(q: 'auto' | 'low' | 'medium' | 'high'): void;
  resize(): void;
  dispose(): void;
}
