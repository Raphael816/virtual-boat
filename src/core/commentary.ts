/**
 * 走行ログとイベントから実況テキストを生成する（時刻は映像の時刻）。
 * 映像と同じ走行ログから作るため、実況と映像・結果が食い違うことはない。
 * 言い回しはレースIDから決まる乱数で選ぶ（同じレースなら毎回同じ実況）。
 */
import { RACER_BY_ID } from '../data/racers';
import { LAP } from './course';
import type { RaceCard } from './meeting';
import { Rng } from './rng';
import { type SimResult, TIDE_LABEL, formatRaceTime } from './sim';

export interface CommentaryLine {
  t: number;
  text: string;
  kind: 'start' | 'pos' | 'event' | 'finish';
}

export function buildCommentary(card: RaceCard, res: SimResult): CommentaryLine[] {
  const rng = new Rng(`commentary:${card.id}`);
  const say = (...variants: string[]) => rng.pick(variants);
  const no = (i: number) => card.entries[i].number;
  const name = (i: number) => `${no(i)}号艇${RACER_BY_ID.get(card.entries[i].racerId)!.name.split(' ')[0]}`;
  const n = res.n;
  const lines: CommentaryLine[] = [];
  const data = res.data;
  const racing = Array.from({ length: n }, (_, i) => i).filter((i) => !res.excluded.includes(i));

  /** 時刻 t の隊列（完走対象の艇を前から順に） */
  const orderAt = (t: number): number[] => {
    if (!data) return res.order;
    const f = Math.min(res.frames - 1, Math.max(0, Math.round(t / res.dt)));
    return [...racing].sort((a, b) => data[(f * n + b) * 3] - data[(f * n + a) * 3]);
  };
  /** 先頭が距離 x に達した時刻 */
  const leaderReaches = (x: number): number | null => {
    if (!data) return null;
    for (let f = 0; f < res.frames; f++) {
      for (const i of racing) if (data[(f * n + i) * 3] >= x) return f * res.dt;
    }
    return null;
  };

  const c = card.conditions;
  lines.push({
    t: 0.3,
    text: `${TIDE_LABEL[c.tide]}、風${Math.abs(c.wind)}m、波${c.wave}cm。各艇スタートへ向かいます。`,
    kind: 'start',
  });

  // スタート
  const valid = racing.filter((i) => res.st[i] >= 0);
  const top = valid.reduce((a, b) => (res.st[b] < res.st[a] ? b : a), valid[0]);
  if (top !== undefined) {
    lines.push({
      t: res.lead + 0.4,
      text: say(
        `スタート！ トップスタートは${name(top)}、コンマ${Math.round(res.st[top] * 100).toString().padStart(2, '0')}！`,
        `スタートしました！ ${name(top)}が好スタート、コンマ${Math.round(res.st[top] * 100).toString().padStart(2, '0')}。`,
      ),
      kind: 'start',
    });
  }
  for (const i of res.excluded) {
    const f = res.flags[i];
    lines.push({
      t: res.lead + 1.2,
      text:
        f === 'F'
          ? `${name(i)}はフライング！ 返還欠場となります。${name(i)}を含む舟券は返還です。`
          : `${name(i)}は出遅れ。返還欠場となります。`,
      kind: 'event',
    });
  }

  // 1周1マーク
  const t1m = leaderReaches(150);
  const w = res.order[0];
  if (t1m !== null && w !== undefined) {
    const o = orderAt(t1m);
    lines.push({
      t: t1m - 0.5,
      text: say(`1マーク！ ${name(o[0])}が先にターン！`, `さあ1マーク、${name(o[0])}が回る！`),
      kind: 'pos',
    });
  }
  const after1M = res.turnOrders.find((x) => x.turn === 0);
  if (after1M) {
    const tAfter = leaderReaches(150 + Math.PI * 15 + 50);
    const o = after1M.order;
    const lead = o[0];
    const how =
      res.kimarite === '逃げ' && lead === w
        ? 'インから逃げる'
        : res.kimarite === 'まくり' && lead === w
          ? '外から豪快にまくった'
          : res.kimarite === '差し' && lead === w
            ? '内を鋭く差した'
            : res.kimarite === 'まくり差し' && lead === w
              ? 'まくり差しで突き抜けた'
              : '抜け出した';
    if (tAfter !== null)
      lines.push({
        t: tAfter,
        text: `${name(lead)}、${how}！ 2番手${name(o[1])}${o[2] !== undefined ? `、3番手${name(o[2])}` : ''}。`,
        kind: 'pos',
      });
  }

  // 周回
  for (const e of res.events) {
    if (e.type === 'lap' && e.lap) {
      const o = orderAt(e.t);
      lines.push({
        t: e.t,
        text:
          e.lap === 2
            ? `最終周回へ！ 先頭${name(o[0])}、2番手${name(o[1])}。`
            : `${e.lap + 1}周目、先頭は${name(o[0])}、2番手${name(o[1])}が追います。`,
        kind: 'pos',
      });
    }
    if (e.type === 'lead' && after1M) {
      const tAfter = leaderReaches(150 + Math.PI * 15 + 50) ?? 0;
      if (e.t > tAfter + 1)
        lines.push({ t: e.t, text: say(`${name(e.runner)}が抜いた！ 先頭が替わります！`, `${name(e.runner)}、ここで逆転！`), kind: 'event' });
    }
  }

  // 2周1マーク
  const t2 = leaderReaches(LAP + 150);
  if (t2 !== null) {
    const o = orderAt(t2);
    lines.push({ t: t2, text: `2周1マーク、${name(o[0])}が先頭をキープ。`, kind: 'pos' });
  }

  // ゴール
  if (w !== undefined) {
    const s2 = res.order[1];
    const s3 = res.order[2];
    const tight = s2 !== undefined && res.finishTimes[s2] - res.finishTimes[w] < 0.5;
    if (tight) lines.push({ t: res.finishTimes[w] - 3, text: `${name(w)}と${name(s2)}、ゴール前は大接戦！`, kind: 'pos' });
    lines.push({ t: res.finishTimes[w], text: `${name(w)}、1着でゴールイン！ 決まり手は「${res.kimarite}」。`, kind: 'finish' });
    if (s2 !== undefined) lines.push({ t: res.finishTimes[s2] + 0.01, text: `2着は${name(s2)}。`, kind: 'finish' });
    if (s3 !== undefined) lines.push({ t: res.finishTimes[s3] + 0.02, text: `3着は${name(s3)}。`, kind: 'finish' });
    const last = res.order[res.order.length - 1];
    lines.push({
      t: res.finishTimes[last] + 0.5,
      text: `レースタイムは${formatRaceTime(res.raceTimes[w])}でした。`,
      kind: 'finish',
    });
  }
  lines.sort((a, b) => a.t - b.t);
  // 近すぎる実況（1.5秒以内）は後のものを少し遅らせて読みやすくする
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].kind !== 'finish' && lines[i].t - lines[i - 1].t < 1.5) lines[i].t = lines[i - 1].t + 1.5;
  }
  return lines;
}
