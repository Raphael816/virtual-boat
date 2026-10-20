/**
 * モンテカルロ法による的中確率の推定。
 *
 * 公開シード `mc:<i>` でシミュレーションを繰り返すため、結果決定用の秘密 seed は一切使わない。
 * つまりオッズから実際の結果が漏れることはない（docs/02-architecture.md §4.3）。
 */
import { BET_TYPES, type BetTypeId, allKeys, winningKeys } from './bettypes';
import { type RaceCard, runRace } from './meeting';

export interface Probabilities {
  trials: number;
  /** 券種ごと・キーごとの的中確率（スムージング済み、合計は的中キー数におおよそ一致） */
  byType: Record<BetTypeId, Record<string, number>>;
}

export function estimateProbabilities(
  card: Pick<RaceCard, 'id' | 'conditions' | 'entries'>,
  trials = 400,
): Probabilities {
  const numbers = card.entries.map((e) => e.number);
  const counts = Object.fromEntries(BET_TYPES.map((t) => [t.id, {} as Record<string, number>])) as Record<
    BetTypeId,
    Record<string, number>
  >;
  for (let i = 0; i < trials; i++) {
    const res = runRace(card, `mc:${i}`, { record: false, dt: 0.1 });
    const order = res.order.map((idx) => card.entries[idx].number);
    for (const t of BET_TYPES) {
      for (const k of winningKeys(t, order)) counts[t.id][k] = (counts[t.id][k] ?? 0) + 1;
    }
  }
  const byType = {} as Probabilities['byType'];
  for (const t of BET_TYPES) {
    const keys = allKeys(t, numbers);
    const hitsPerTrial = t.hits;
    // 一度も起きなかった組み合わせにも小さな確率を残す（加法スムージング）
    const alpha = 0.5;
    const denom = trials * hitsPerTrial + alpha * keys.length;
    byType[t.id] = Object.fromEntries(keys.map((k) => [k, (((counts[t.id][k] ?? 0) + alpha) / denom) * hitsPerTrial]));
  }
  return { trials, byType };
}
