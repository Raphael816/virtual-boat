/**
 * パリミュチュエル方式（投票プール方式）のオッズと払戻の計算。
 *
 * オッズ = 払戻対象額 ÷ その組み合わせへの投票額
 *   払戻対象額 = プール総額 × (1 − 控除率)
 * 10コイン未満は切り捨て（100コインあたり10コイン単位 ＝ オッズ0.1倍単位）、最低1.0倍。
 *
 * デモでは他の利用者の投票を「市場プール」として模擬する。市場の配分は推定確率に
 * 偏り（人気の偏り）と時間で変わるゆらぎを加えたもので、締切時点で固定される。
 */
import { BET_TYPES, type BetType, type BetTypeId, allKeys, keyHasAny, winningKeys } from './bettypes';
import type { Probabilities } from './probability';
import { Rng } from './rng';

export type Pools = Record<BetTypeId, Record<string, number>>;

export interface StakeLike {
  betType: BetTypeId;
  key: string;
  stake: number;
}

export const floorOdds = (x: number): number => Math.max(1, Math.floor(x * 10 + 1e-9) / 10);

export function emptyPools(): Pools {
  return Object.fromEntries(BET_TYPES.map((t) => [t.id, {}])) as unknown as Pools;
}

/**
 * 発売の進み具合 progress(0〜1) と時間の刻み tick における市場プール。
 * 乱数は raceId と tick から決まる公開情報で、結果決定用 seed とは無関係。
 */
export function marketPools(raceId: string, numbers: number[], probs: Probabilities, progress: number, tick: number): Pools {
  const pools = emptyPools();
  const p = Math.max(0.05, Math.min(1, progress));
  for (const t of BET_TYPES) {
    const keys = allKeys(t, numbers);
    const bias = new Rng(`${raceId}:bias:${t.id}`);
    const wobble = new Rng(`${raceId}:tick:${t.id}:${tick}`);
    const wobbleSd = 0.3 * (1 - p) + 0.06;
    // どの組み合わせにも一定の票が入る（記念買い・応援買い）。平均シェアの5%を下限として上乗せ
    const floor = (0.05 * t.hits) / keys.length;
    const weights = keys.map((k) => {
      const prob = (probs.byType[t.id][k] ?? 0) + floor;
      // 大穴が実際の確率より買われやすい傾向を、指数 0.92 で表現
      return Math.pow(prob, 0.92) * Math.exp(bias.normal(0, 0.15) + wobble.normal(0, wobbleSd));
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const size = t.marketSize * p;
    keys.forEach((k, i) => {
      pools[t.id][k] = Math.round((size * weights[i]) / total);
    });
  }
  return pools;
}

/** 市場プールに利用者の投票を加える */
export function withStakes(base: Pools, stakes: StakeLike[]): Pools {
  const pools = Object.fromEntries(BET_TYPES.map((t) => [t.id, { ...base[t.id] }])) as unknown as Pools;
  for (const s of stakes) pools[s.betType][s.key] = (pools[s.betType][s.key] ?? 0) + s.stake;
  return pools;
}

export function poolTotal(pools: Pools, type: BetTypeId): number {
  return Object.values(pools[type]).reduce((a, b) => a + b, 0);
}

/** 単勝・2連単・3連単など（的中キーが1つ）のオッズ */
export function standardOdds(type: BetType, pools: Pools, key: string): number | null {
  const stake = pools[type.id][key] ?? 0;
  if (stake <= 0) return null;
  return floorOdds((poolTotal(pools, type.id) * (1 - type.takeout)) / stake);
}

/** 複勝・拡連複：的中したキーの組から、それぞれの払戻オッズを求める */
export function multiOddsFor(type: BetType, pools: Pools, winners: string[]): Record<string, number> {
  const net = poolTotal(pools, type.id) * (1 - type.takeout);
  const winStakes = winners.map((k) => pools[type.id][k] ?? 0);
  const profit = net - winStakes.reduce((a, b) => a + b, 0);
  const share = Math.max(0, profit) / winners.length;
  const res: Record<string, number> = {};
  winners.forEach((k, i) => {
    res[k] = winStakes[i] > 0 ? floorOdds(1 + share / winStakes[i]) : 1;
  });
  return res;
}

/** 複勝・拡連複の確定前の想定オッズ幅（一緒に的中する他の組が人気なら下限、人気薄なら上限） */
export function multiOddsRange(type: BetType, pools: Pools, key: string): [number, number] | null {
  if (!(pools[type.id][key] > 0)) return null;
  const others = Object.entries(pools[type.id])
    .filter(([k]) => k !== key)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  const m = type.hits - 1;
  const low = multiOddsFor(type, pools, [key, ...others.slice(0, m)])[key];
  const high = multiOddsFor(type, pools, [key, ...others.slice(-m)])[key];
  return [low, high];
}

export interface OddsBook {
  /** 券種 → キー → オッズ（複勝・拡連複は下限） */
  odds: Record<BetTypeId, Record<string, number | null>>;
  /** 複勝・拡連複のオッズ幅（券種 → キー → [下限, 上限]） */
  ranges: Partial<Record<BetTypeId, Record<string, [number, number] | null>>>;
  totals: Record<BetTypeId, number>;
}

export function buildOddsBook(pools: Pools, numbers: number[]): OddsBook {
  const odds = {} as OddsBook['odds'];
  const totals = {} as OddsBook['totals'];
  const ranges: OddsBook['ranges'] = {};
  for (const t of BET_TYPES) {
    totals[t.id] = poolTotal(pools, t.id);
    odds[t.id] = {};
    if (t.poolKind === 'multi') ranges[t.id] = {};
    for (const k of allKeys(t, numbers)) {
      if (t.poolKind === 'multi') {
        const r = multiOddsRange(t, pools, k);
        ranges[t.id]![k] = r;
        odds[t.id][k] = r ? r[0] : null;
      } else {
        odds[t.id][k] = standardOdds(t, pools, k);
      }
    }
  }
  return { odds, ranges, totals };
}

export interface Settlement {
  /** 券種 → 的中キー → 確定オッズ */
  odds: Record<BetTypeId, Record<string, number>>;
  /** 不成立で全額返還となった券種 */
  voidTypes: BetTypeId[];
  /** 欠場（フライング・出遅れ）で返還となった艇番 */
  excluded: number[];
}

/**
 * 確定着順（完走艇）と欠場艇から、券種ごとの的中キーと払戻オッズを求める。
 * 欠場艇を含む組み合わせへの投票は返還されるため、プールから除いてから計算する。
 */
export function settleOdds(pools: Pools, order: number[], excluded: number[] = []): Settlement {
  const odds = {} as Settlement['odds'];
  const voidTypes: BetTypeId[] = [];
  for (const t of BET_TYPES) {
    const pool = Object.fromEntries(Object.entries(pools[t.id]).filter(([k]) => !keyHasAny(k, excluded)));
    const p = { ...pools, [t.id]: pool } as Pools;
    const winners = winningKeys(t, order);
    if (winners.length === 0) {
      voidTypes.push(t.id);
      odds[t.id] = {};
    } else if (t.poolKind === 'multi') {
      odds[t.id] = multiOddsFor(t, p, winners);
    } else {
      // 誰も買っていない組み合わせが的中した場合は払戻なし（デモでは市場プールがあるため通常発生しない）
      const o = standardOdds(t, p, winners[0]);
      odds[t.id] = o ? { [winners[0]]: o } : {};
    }
  }
  return { odds, voidTypes, excluded };
}

/** 払戻額 = 賭け金 × オッズ（賭け金は100単位なので結果は整数） */
export function payout(stake: number, odds: number): number {
  return Math.round(stake * odds);
}

/** 人気順（その券種でのオッズが低い順）。表示用 */
export function popularity(book: OddsBook, type: BetTypeId): string[] {
  return Object.entries(book.odds[type])
    .filter(([, o]) => o !== null)
    .sort((a, b) => (a[1] as number) - (b[1] as number))
    .map(([k]) => k);
}

