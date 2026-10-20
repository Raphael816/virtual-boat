/**
 * 開催（1日12レース・各6艇）の生成と、結果決定用 seed のコミット・リビール。
 *
 * - 出走表・モーター・展示タイム・水面条件は開催ID から決定論的に生成する（公開情報）
 * - 結果決定用 seed は暗号論的乱数で生成し、ハッシュだけを事前に公開する
 */
import { type Grade, RACER_BY_ID, RACERS } from '../data/racers';
import { Rng, secureSeed, sha256Hex } from './rng';
import {
  ENGINE_VERSION,
  type Motor,
  type RaceConditions,
  type SimOptions,
  type SimResult,
  type Tide,
  type TimeOfDay,
  type Weather,
  simulateRace,
} from './sim';
import { DISTANCE } from './course';

export interface RaceEntry {
  racerId: string;
  /** 艇番（1〜6。枠なり進入のためコースと同じ） */
  number: number;
  motor: Motor;
  boatNo: number;
  /** ボート2連対率 (%) */
  boatRate: number;
  /** 展示タイム（秒、150m） */
  exhibition: number;
}

export interface RaceCard {
  id: string;
  meetingId: string;
  no: number;
  name: string;
  conditions: RaceConditions;
  entries: RaceEntry[];
  /** 結果決定用 seed（本番ではサーバーのみが保持し、確定後に公開） */
  seed: string;
  /** SHA-256(commitInput) — 発売開始時に公開 */
  commit: string;
  engineVersion: string;
}

/** レース名（一般的な番組の呼び方。特定の大会名は使わない） */
const PLAN: { name: string; strength: number; time: TimeOfDay }[] = [
  { name: '一般戦', strength: 0, time: 'day' },
  { name: '一般戦', strength: 0, time: 'day' },
  { name: '予選', strength: 0.3, time: 'day' },
  { name: '予選', strength: 0.3, time: 'day' },
  { name: '予選', strength: 0.4, time: 'day' },
  { name: '一般戦', strength: 0.2, time: 'day' },
  { name: '予選', strength: 0.5, time: 'day' },
  { name: '予選', strength: 0.5, time: 'day' },
  { name: '特選', strength: 0.7, time: 'day' },
  { name: '特選', strength: 0.8, time: 'dusk' },
  { name: '選抜戦', strength: 0.9, time: 'dusk' },
  { name: '翠川選抜', strength: 1, time: 'dusk' },
];

const WEATHERS: Weather[] = ['sunny', 'cloudy', 'rain'];
const GRADE_SCORE: Record<Grade, number> = { A1: 4, A2: 3, B1: 2, B2: 1 };

export function commitInput(raceId: string, seed: string, engineVersion = ENGINE_VERSION): string {
  return `${raceId}|${seed}|${engineVersion}`;
}

/** 開催で使うモーター（2連対率は隠れた性能と相関する公開情報） */
function motorsFor(rng: Rng): Motor[] {
  const nos = rng.shuffle(Array.from({ length: 60 }, (_, i) => i + 11)).slice(0, RACERS.length);
  return nos.map((no) => {
    const power = Math.max(5, Math.min(95, rng.normal(50, 16)));
    const rate = Math.round(Math.max(12, Math.min(65, 20 + power * 0.42 + rng.normal(0, 4))) * 10) / 10;
    return { no, rate, power };
  });
}

/**
 * 開催を生成する。`seedFn` はテスト用に差し替えられる（既定は暗号論的乱数）。
 */
export async function createMeeting(meetingId: string, seedFn: () => string = secureSeed): Promise<RaceCard[]> {
  const rng = new Rng(`meeting:${meetingId}`);
  // 選手ごとにこの開催のモーター・ボートを抽選
  const motors = motorsFor(rng);
  const gear = new Map(
    RACERS.map((r, i) => [r.id, { motor: motors[i], boatNo: rng.int(11, 70), boatRate: Math.round(rng.normal(33, 6) * 10) / 10 }]),
  );
  let weatherIdx = rng.chance(0.55) ? 0 : rng.chance(0.75) ? 1 : 2;
  let wind = rng.normal(0, 2.5);
  // 潮：河川の水面なので1日の中で上げ潮・下げ潮が入れ替わる（開始時の潮と転換レースを決める）
  const firstTide: Tide = rng.chance(0.5) ? 'rising' : 'falling';
  const tideTurn = rng.int(4, 9);
  const usage = new Map<string, number>();
  const cards: RaceCard[] = [];

  for (let r = 0; r < PLAN.length; r++) {
    const plan = PLAN[r];
    if (r > 0 && rng.chance(0.15)) weatherIdx = Math.max(0, Math.min(2, weatherIdx + (rng.chance(0.5) ? 1 : -1)));
    wind = Math.max(-8, Math.min(8, wind * 0.85 + rng.normal(0, 1)));
    const absWind = Math.abs(wind);
    const wave = Math.max(1, Math.round(absWind * 1.4 + rng.normal(1.5, 1) + (weatherIdx === 2 ? 2 : 0)));
    const tide: Tide =
      r === tideTurn - 1 ? 'slack' : r < tideTurn ? firstTide : firstTide === 'rising' ? 'falling' : 'rising';
    const conditions: RaceConditions = {
      distance: DISTANCE,
      weather: WEATHERS[weatherIdx],
      wind: Math.round(wind),
      wave,
      tide,
      timeOfDay: plan.time,
    };

    // 出走選手：番組の格に応じて級別で重み付け。1日3走まで（多くは2走）
    const pool = RACERS.filter((x) => (usage.get(x.id) ?? 0) < 3);
    const weights = pool.map((x) => {
      const g = GRADE_SCORE[x.grade];
      return Math.exp(plan.strength * (g - 2.5) * 1.1) / (1 + 3 * (usage.get(x.id) ?? 0) ** 2);
    });
    const chosen: string[] = [];
    while (chosen.length < 6) {
      const total = weights.reduce((a, b) => a + b, 0);
      let x = rng.next() * total;
      let idx = pool.length - 1;
      for (let i = 0; i < pool.length; i++) {
        x -= weights[i];
        if (x <= 0) {
          idx = i;
          break;
        }
      }
      chosen.push(pool[idx].id);
      pool.splice(idx, 1);
      weights.splice(idx, 1);
    }
    chosen.forEach((id) => usage.set(id, (usage.get(id) ?? 0) + 1));
    // 枠：格上の番組ほど1号艇に有力選手が入りやすい（番組編成の慣例を簡略化）
    rng.shuffle(chosen);
    if (plan.strength >= 0.5) {
      const best = chosen.reduce((a, b) => (GRADE_SCORE[RACER_BY_ID.get(b)!.grade] > GRADE_SCORE[RACER_BY_ID.get(a)!.grade] ? b : a));
      chosen.splice(chosen.indexOf(best), 1);
      chosen.unshift(best);
    }
    const entries: RaceEntry[] = chosen.map((racerId, i) => {
      const g = gear.get(racerId)!;
      const racer = RACER_BY_ID.get(racerId)!;
      // 展示タイム：モーターと選手の伸び・体重から（公開情報なので結果用 seed とは無関係の乱数）
      const ex = 6.82 - (g.motor.power - 50) * 0.0028 - (racer.speed - 70) * 0.0015 + (racer.weight - 51) * 0.006 + rng.normal(0, 0.035) + wave * 0.004;
      return {
        racerId,
        number: i + 1,
        motor: g.motor,
        boatNo: g.boatNo,
        boatRate: g.boatRate,
        exhibition: Math.round(ex * 100) / 100,
      };
    });

    const id = `${meetingId}-R${r + 1}`;
    const seed = seedFn();
    cards.push({
      id,
      meetingId,
      no: r + 1,
      name: plan.name,
      conditions,
      entries,
      seed,
      commit: await sha256Hex(commitInput(id, seed)),
      engineVersion: ENGINE_VERSION,
    });
  }
  return cards;
}

/** 出走表と seed からレースを実行する（結果決定用・モンテカルロ用で共通） */
export function runRace(card: Pick<RaceCard, 'id' | 'conditions' | 'entries'>, seed: string, opts?: SimOptions): SimResult {
  const boats = card.entries.map((e) => {
    const racer = RACER_BY_ID.get(e.racerId);
    if (!racer) throw new Error(`unknown racer ${e.racerId}`);
    return { racer, number: e.number, motor: e.motor, boatNo: e.boatNo };
  });
  return simulateRace(card.conditions, boats, `${card.id}|${seed}`, opts);
}

export interface VerifyResult {
  hashOk: boolean;
  recomputedHash: string;
  /** 艇番での着順（完走艇） */
  order: number[];
  /** 欠場艇の艇番 */
  excluded: number[];
}

/** 公開された seed を使って、コミットとの一致と着順を再計算する */
export async function verifyRace(card: RaceCard, revealedSeed: string): Promise<VerifyResult> {
  const recomputedHash = await sha256Hex(commitInput(card.id, revealedSeed, card.engineVersion));
  const res = runRace(card, revealedSeed, { record: false });
  return {
    hashOk: recomputedHash === card.commit,
    recomputedHash,
    order: res.order.map((i) => card.entries[i].number),
    excluded: res.excluded.map((i) => card.entries[i].number),
  };
}
