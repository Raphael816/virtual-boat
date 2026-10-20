/**
 * レース後の振り返り解説。
 * シミュレーションが記録した要素（スタートタイミング・1マークの進入・ターンの流れ・引き波・モーター・水面条件）から、
 * 勝因と人気艇の敗因を短い文章にする。結果を「説明できる」ことが目的で、予想や投票を勧める表現は使わない。
 */
import { RACER_BY_ID } from '../data/racers';
import type { RaceCard } from './meeting';
import { type SimResult, TIDE_LABEL } from './sim';

export interface FactorRow {
  number: number;
  name: string;
  /** 着順（欠場は 0） */
  rank: number;
  st: number;
  flag: string;
  rankAfter1M: number;
  drift1M: number;
  wakeTime: number;
  motorRate: number;
  notes: string[];
}

export interface RaceAnalysis {
  headline: string;
  points: string[];
  favoriteNote: string | null;
  rows: FactorRow[];
}

export const stText = (st: number) => (st < 0 ? `F.${Math.round(-st * 100).toString().padStart(2, '0')}` : `.${Math.round(st * 100).toString().padStart(2, '0')}`);

export function analyzeRace(card: RaceCard, res: SimResult, favoriteNumber?: number): RaceAnalysis {
  const n = res.n;
  const racer = (i: number) => RACER_BY_ID.get(card.entries[i].racerId)!;
  const label = (i: number) => `${card.entries[i].number}号艇${racer(i).name}`;
  const rankOf = (i: number) => res.order.indexOf(i) + 1;
  const c = card.conditions;
  const points: string[] = [];
  const w = res.order[0];
  if (w === undefined) {
    return { headline: '完走艇がなくレース不成立（全額返還）', points: [], favoriteNote: null, rows: [] };
  }
  const f = res.factors[w];
  const lane = card.entries[w].number;
  const racingSt = Array.from({ length: n }, (_, i) => i).filter((i) => !res.excluded.includes(i));
  const stRank = [...racingSt].sort((a, b) => res.st[a] - res.st[b]).indexOf(w) + 1;

  // 1. スタート
  points.push(
    stRank === 1
      ? `スタートタイミング${stText(res.st[w])}はメンバー最速。${lane >= 4 ? 'ダッシュ' : 'スロー'}からの好発が勝因の一つです。`
      : `スタートタイミングは${stText(res.st[w])}（${stRank}番目）。`,
  );

  // 2. 決まり手と1マーク
  switch (res.kimarite) {
    case '逃げ':
      points.push(`1コースから先にターンし、そのまま後続を寄せ付けませんでした${f.drift1M < 2 ? '。ターンの流れも小さく' : ''}。`);
      break;
    case '差し':
      points.push(`1マークで先に回った艇の内側を突き、ターン出口で抜け出しました（差し）。`);
      break;
    case 'まくり':
      points.push(`内側の艇より外を回りながら、勢いで一気に前に出ました（まくり）。`);
      break;
    case 'まくり差し':
      points.push(`外の艇を回りながら、流れた内側の艇の内を突いて抜け出しました（まくり差し）。`);
      break;
    case '抜き':
      points.push(`1周1マークは${f.rankAfter1M}番手でしたが、道中で逆転しました（抜き）。`);
      break;
    case '恵まれ':
      points.push(`内側の艇の欠場があり、展開に恵まれました。`);
      break;
  }

  // 3. モーター・水面
  const motor = card.entries[w].motor;
  if (motor.rate >= 40) points.push(`モーター2連対率${motor.rate.toFixed(1)}%の好機を生かしました。`);
  if (c.wave >= 6 && racer(w).wave >= 80) points.push(`波${c.wave}cmの荒れた水面でも安定したターンができました。`);
  if (c.tide !== 'slack') {
    const fit = (c.tide === 'rising' && lane <= 3) || (c.tide === 'falling' && lane >= 4);
    if (fit) points.push(`${TIDE_LABEL[c.tide]}は${lane <= 3 ? 'スロー' : 'ダッシュ'}勢に向くとされ、条件も合っていました。`);
  }

  // 4. 着差
  const s2 = res.order[1];
  if (s2 !== undefined) {
    const gap = res.finishTimes[s2] - res.finishTimes[w];
    points.push(gap < 0.5 ? `2着の${label(s2)}とは僅差の争いでした。` : `2着の${label(s2)}に約${Math.round(gap * 20)}mの差をつけました。`);
  }

  // 人気艇の敗因
  let favoriteNote: string | null = null;
  const favIdx = favoriteNumber ? card.entries.findIndex((e) => e.number === favoriteNumber) : -1;
  if (favIdx >= 0 && favIdx !== w) {
    const ff = res.factors[favIdx];
    if (ff.flag) {
      favoriteNote = `1番人気の${label(favIdx)}は${ff.flag === 'F' ? 'フライング' : '出遅れ'}で返還欠場となりました。`;
    } else {
      const reasons: string[] = [];
      if (ff.st - res.st[w] > 0.08) reasons.push(`スタートで後手を踏み（${stText(ff.st)}）`);
      if (ff.drift1M > 4) reasons.push(`1マークでターンが流れ（約${ff.drift1M.toFixed(0)}m）`);
      if (ff.wakeTime > 4) reasons.push(`前の艇の引き波を長く受け（約${ff.wakeTime.toFixed(0)}秒）`);
      if (ff.rankAfter1M >= 4) reasons.push(`1周1マークを${ff.rankAfter1M}番手で回り`);
      const why = reasons.length ? reasons.slice(0, 2).join('、') : `${res.kimarite}を許し`;
      favoriteNote = `1番人気の${label(favIdx)}は、${why}${rankOf(favIdx)}着でした。`;
    }
  }

  const ids = [...res.order, ...res.excluded];
  const rows: FactorRow[] = ids.map((i) => {
    const fx = res.factors[i];
    const notes: string[] = [];
    if (fx.flag === 'F') notes.push('フライング');
    if (fx.flag === 'L') notes.push('出遅れ');
    if (!fx.flag && fx.drift1M > 4) notes.push('ターン流れ');
    if (!fx.flag && fx.wakeTime > 4) notes.push('引き波');
    return {
      number: card.entries[i].number,
      name: racer(i).name,
      rank: fx.flag ? 0 : rankOf(i),
      st: fx.st,
      flag: fx.flag ?? '',
      rankAfter1M: fx.flag ? 0 : fx.rankAfter1M,
      drift1M: fx.drift1M,
      wakeTime: fx.wakeTime,
      motorRate: card.entries[i].motor.rate,
      notes,
    };
  });

  return {
    headline: `${label(w)}が「${res.kimarite}」で1着`,
    points: points.slice(0, 5),
    favoriteNote,
    rows,
  };
}
