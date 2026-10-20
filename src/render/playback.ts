/**
 * 走行ログの再生制御。生中継（発走時刻に同期）とリプレイ（速度変更・一時停止・シーク）に対応する。
 */
import type { RaceCard } from '../core/meeting';
import { type SimResult, sampleAt } from '../core/sim';
import type { BoatFrame } from './types';

export class Playback {
  readonly duration: number;
  private samples: { x: number; lane: number; v: number }[] = [];
  private frames: BoatFrame[];
  // リプレイ用の時計
  private replayTime = 0;
  private lastWall = 0;
  speed = 1;
  paused = false;

  constructor(
    readonly card: RaceCard,
    readonly result: SimResult,
  ) {
    this.duration = (result.frames - 1) * result.dt;
    this.frames = card.entries.map((e, i) => ({
      index: i,
      number: e.number,
      x: 0,
      lane: 0,
      v: 0,
      rank: i + 1,
      finished: false,
      out: result.excluded.includes(i),
    }));
  }

  /** リプレイの時計を進め、現在のレース時刻を返す */
  replayClock(wallMs: number): number {
    if (this.lastWall && !this.paused) {
      this.replayTime = Math.min(this.duration, this.replayTime + ((wallMs - this.lastWall) / 1000) * this.speed);
    }
    this.lastWall = wallMs;
    return this.replayTime;
  }

  seek(t: number) {
    this.replayTime = Math.max(0, Math.min(this.duration, t));
  }

  get time() {
    return this.replayTime;
  }

  /** 時刻 t の各艇の状態と順位 */
  at(t: number): BoatFrame[] {
    sampleAt(this.result, t, this.samples);
    const D = this.card.conditions.distance;
    const ft = this.result.finishTimes;
    this.frames.forEach((f, i) => {
      f.x = this.samples[i].x;
      f.lane = this.samples[i].lane;
      f.v = this.samples[i].v;
      f.finished = t >= ft[i];
    });
    // 入線済みの艇は着順、未入線の艇は走行距離で並べる（欠場艇は最後）
    const order = [...this.frames].sort((a, b) => {
      if (a.out !== b.out) return a.out ? 1 : -1;
      if (a.finished && b.finished) return ft[a.index] - ft[b.index];
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return Math.min(b.x, D) - Math.min(a.x, D);
    });
    order.forEach((f, r) => (f.rank = r + 1));
    return this.frames;
  }

  ranking(t: number): BoatFrame[] {
    return [...this.at(t)].sort((a, b) => a.rank - b.rank);
  }

  leaderRemaining(frames: BoatFrame[]): number {
    const lead = Math.max(...frames.filter((f) => !f.out).map((f) => f.x));
    return Math.max(0, this.card.conditions.distance - lead);
  }
}

/** 発走前の表示用：スタート前の待機位置に並べたフレーム（スロー勢は手前、ダッシュ勢は後方） */
export function gateFrames(card: RaceCard): BoatFrame[] {
  return card.entries.map((e, i) => ({
    index: i,
    number: e.number,
    x: e.number >= 4 ? -125 : -108,
    lane: 3 + (e.number - 1) * 5.2,
    v: 0,
    rank: i + 1,
    finished: false,
    out: false,
  }));
}
