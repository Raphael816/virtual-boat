/**
 * 券種の定義（登録の仕組み）。ボートレースで一般的な7券種。
 * 券種を1つ追加すれば、勝率推定・オッズ計算・払戻・画面に自動で反映される。
 *
 * フライング・出遅れで欠場した艇を含む組み合わせは返還（docs/03-legal-and-safety.md）。
 * 完走艇が足りず的中の組み合わせを作れない券種は「不成立」として全額返還。
 */

export type BetTypeId = 'win' | 'place' | 'exacta' | 'quinella' | 'wide' | 'trifecta' | 'trio';

/**
 * standard: 的中キーが1つで、プール全体をその的中者で分ける
 * multi:    的中キーが複数（複勝・拡連複）。利益分を的中キーの数で等分してから各キーの的中者で分ける
 */
export type PoolKind = 'standard' | 'multi';

export interface BetType {
  id: BetTypeId;
  label: string;
  /** 選ぶ艇の数 */
  picks: number;
  /** 着順どおりに当てる必要があるか */
  ordered: boolean;
  /** 控除率（デモ設定。ボートレースで一般的な25%） */
  takeout: number;
  poolKind: PoolKind;
  /** 1レースあたりの的中キーの数（6艇がそろって完走した場合） */
  hits: number;
  /** 他の利用者の投票を模した市場プールの最終規模（デモコイン） */
  marketSize: number;
  description: string;
}

export const BET_TYPES: BetType[] = [
  { id: 'trifecta', label: '3連単', picks: 3, ordered: true, takeout: 0.25, poolKind: 'standard', hits: 1, marketSize: 8_000_000, description: '1着・2着・3着を着順どおりに当てます（120通り）。' },
  { id: 'trio', label: '3連複', picks: 3, ordered: false, takeout: 0.25, poolKind: 'standard', hits: 1, marketSize: 2_000_000, description: '1〜3着の3艇を、着順を問わずに当てます（20通り）。' },
  { id: 'exacta', label: '2連単', picks: 2, ordered: true, takeout: 0.25, poolKind: 'standard', hits: 1, marketSize: 2_000_000, description: '1着・2着を着順どおりに当てます（30通り）。' },
  { id: 'quinella', label: '2連複', picks: 2, ordered: false, takeout: 0.25, poolKind: 'standard', hits: 1, marketSize: 1_000_000, description: '1着・2着の2艇を、着順を問わずに当てます（15通り）。' },
  { id: 'wide', label: '拡連複', picks: 2, ordered: false, takeout: 0.25, poolKind: 'multi', hits: 3, marketSize: 800_000, description: '3着以内に入る2艇を当てます（的中は3通り）。払戻は確定まで幅で表示されます。' },
  { id: 'win', label: '単勝', picks: 1, ordered: false, takeout: 0.25, poolKind: 'standard', hits: 1, marketSize: 500_000, description: '1着になる艇を当てます。' },
  { id: 'place', label: '複勝', picks: 1, ordered: false, takeout: 0.25, poolKind: 'multi', hits: 2, marketSize: 400_000, description: '2着以内に入る艇を当てます。払戻は確定まで幅で表示されます。' },
];

export const BET_TYPE_BY_ID = Object.fromEntries(BET_TYPES.map((b) => [b.id, b])) as Record<BetTypeId, BetType>;

/** 選択した艇番の並びからプールのキーを作る */
export function betKey(type: BetType, selection: number[]): string {
  const sel = type.ordered ? selection : [...selection].sort((a, b) => a - b);
  return sel.join(type.ordered ? '-' : '=');
}

export function parseKey(key: string): number[] {
  return key.split(/[-=]/).map(Number);
}

/** 組み合わせの組（未順序）を列挙 */
function combos(items: number[], k: number): number[][] {
  if (k === 0) return [[]];
  const res: number[][] = [];
  items.forEach((n, i) => {
    for (const rest of combos(items.slice(i + 1), k - 1)) res.push([n, ...rest]);
  });
  return res;
}

/**
 * 確定着順（完走艇の艇番の並び）に対する的中キー。
 * 完走艇が足りず組み合わせを作れない場合は空配列（不成立 → 返還）。
 */
export function winningKeys(type: BetType, order: number[]): string[] {
  switch (type.id) {
    case 'place':
      return order.slice(0, 2).map(String);
    case 'wide': {
      const top = order.slice(0, 3);
      if (top.length < 2) return [];
      return combos(top, 2).map((c) => betKey(type, c));
    }
    default:
      if (order.length < type.picks) return [];
      return [betKey(type, order.slice(0, type.picks))];
  }
}

/** 出走艇の艇番から、その券種のすべての組み合わせキーを列挙する */
export function allKeys(type: BetType, numbers: number[]): string[] {
  const res: string[] = [];
  const rec = (prefix: number[], rest: number[]) => {
    if (prefix.length === type.picks) {
      res.push(betKey(type, prefix));
      return;
    }
    rest.forEach((n, i) => {
      const next = type.ordered ? rest.filter((_, j) => j !== i) : rest.slice(i + 1);
      rec([...prefix, n], next);
    });
  };
  rec([], [...numbers].sort((a, b) => a - b));
  return res;
}

/** キーに欠場艇が含まれるか */
export function keyHasAny(key: string, numbers: number[]): boolean {
  return parseKey(key).some((n) => numbers.includes(n));
}

export function validateSelection(type: BetType, selection: number[], numbers: number[]): string | null {
  if (selection.length !== type.picks) return `${type.label}は${type.picks}艇を選んでください。`;
  if (new Set(selection).size !== selection.length) return '同じ艇を重複して選ぶことはできません。';
  if (selection.some((n) => !numbers.includes(n))) return '出走していない艇番が含まれています。';
  return null;
}
