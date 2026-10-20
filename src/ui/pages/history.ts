import { BET_TYPE_BY_ID } from '../../core/bettypes';
import { dayStats } from '../../core/responsible';
import { REFILL_AMOUNT, canRefill, raceSummaries, refill } from '../../core/state';
import type { Page } from '../common';
import { store } from '../store';
import { coins, dateTime, esc, signClass, signed, toast } from '../util';

/** 残高推移の折れ線（SVG） */
function balanceChart(points: { ts: number; balance: number }[]): string {
  if (points.length < 2) return '<p class="muted">投票すると残高の推移が表示されます。</p>';
  const W = 600;
  const H = 180;
  const pad = { l: 48, r: 8, t: 10, b: 22 };
  const vals = points.map((p) => p.balance);
  // 変化が見えるよう、値の範囲に合わせて縦軸を決める（0 を含めない）
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const padV = Math.max(500, (hi - lo) * 0.15);
  const min = Math.max(0, lo - padV);
  const max = hi + padV;
  const x = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / (points.length - 1);
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min || 1)) * (H - pad.t - pad.b);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join('');
  const area = `${d}L${x(points.length - 1)},${y(min)}L${x(0)},${y(min)}Z`;
  const ticks = [min, (min + max) / 2, max]
    .map((v) => `<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${coins(v)}</text><line class="axis" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`)
    .join('');
  const last = points.at(-1)!;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
    aria-label="残高の推移。開始時 ${coins(points[0].balance)}、現在 ${coins(last.balance)}コイン">
    ${ticks}<path class="area" d="${area}"/><path class="line" d="${d}"/></svg>`;
}

export function historyPage(): Page {
  let el: HTMLElement;
  const draw = () => {
    const s = store.state;
    const now = store.now();
    const sums = raceSummaries(s);
    const totalStake = s.tickets.reduce((a, t) => a + t.stake, 0);
    const totalPay = s.tickets.reduce((a, t) => a + (t.payout ?? 0), 0);
    const settled = s.tickets.filter((t) => t.status !== 'open');
    const hits = settled.filter((t) => t.status === 'won').length;
    const judged = settled.filter((t) => t.status !== 'refunded');
    const today = dayStats(s, now);
    const name = (id: string) => esc(s.raceNames?.[id] ?? id);

    el.innerHTML = `
      <h1>結果・収支</h1>
      <div class="grid grid-4">
        <div class="card stat"><span class="label">残高</span><span class="value">${coins(s.balance)}</span></div>
        <div class="card stat"><span class="label">通算収支（確定分）</span><span class="value ${signClass(totalPay - settled.reduce((a, t) => a + t.stake, 0))}">${signed(totalPay - settled.reduce((a, t) => a + t.stake, 0))}</span></div>
        <div class="card stat"><span class="label">本日の投票 / 収支</span><span class="value" style="font-size:1.05rem">${coins(today.staked)} / <span class="${signClass(today.settledNet)}">${signed(today.settledNet)}</span></span></div>
        <div class="card stat"><span class="label">的中率</span><span class="value">${judged.length ? Math.round((hits / judged.length) * 100) : 0}%</span><small>${hits} / ${judged.length}件</small></div>
      </div>
      ${
        canRefill(s, now)
          ? `<p class="notice notice-info" style="margin-top:12px">残高が少なくなっています。本日分の補充（${coins(REFILL_AMOUNT)}コイン）を受け取れます。 <button class="btn btn-sm" data-refill>補充する</button></p>`
          : ''
      }
      <section class="card" style="margin-top:12px" aria-labelledby="ch-h"><h2 id="ch-h">残高の推移</h2>${balanceChart(s.ledger)}</section>

      <section class="card" style="margin-top:12px" aria-labelledby="race-h"><h2 id="race-h">レース別収支</h2>
        ${
          sums.length
            ? `<div class="table-wrap"><table class="table"><thead><tr><th>レース</th><th class="r">投票</th><th class="r">払戻</th><th class="r">収支</th><th class="r">的中</th></tr></thead><tbody>
              ${sums
                .map(
                  (r) => `<tr><td><a href="#/race/${encodeURIComponent(r.raceId)}">${name(r.raceId)}</a>${r.settled ? '' : ' <span class="chip chip-open">未確定</span>'}</td>
                  <td class="r tnum">${coins(r.stake)}</td><td class="r tnum">${coins(r.payout)}</td>
                  <td class="r tnum ${r.settled ? signClass(r.net) : ''}">${r.settled ? signed(r.net) : '—'}</td><td class="r">${r.hits}/${r.tickets}</td></tr>`,
                )
                .join('')}</tbody></table></div>`
            : '<p class="muted">まだ投票していません。<a href="#/races">レース一覧へ</a></p>'
        }
        <p class="muted" style="font-size:.82rem">合計 投票 ${coins(totalStake)}・払戻 ${coins(totalPay)}</p>
      </section>

      <section class="card" style="margin-top:12px" aria-labelledby="tk-h"><h2 id="tk-h">購入履歴</h2>
        ${
          s.tickets.length
            ? `<div class="table-wrap"><table class="table nowrap"><thead><tr><th>日時</th><th>レース</th><th>券種</th><th>選択</th><th class="r">賭け金</th><th class="r">オッズ（購入時→確定）</th><th class="r">払戻</th></tr></thead><tbody>
              ${[...s.tickets]
                .reverse()
                .map((t) => {
                  const type = BET_TYPE_BY_ID[t.betType];
                  const atBuy = t.rangeAtPurchase ? `${t.rangeAtPurchase[0]}–${t.rangeAtPurchase[1]}` : (t.oddsAtPurchase?.toFixed(1) ?? '—');
                  const fin = t.status === 'won' ? t.finalOdds!.toFixed(1) : t.status === 'lost' ? '不的中' : t.status === 'refunded' ? '返還' : '未確定';
                  return `<tr><td class="tnum">${dateTime(t.ts)}</td><td>${name(t.raceId)}</td><td>${type.label}</td>
                    <td>${t.selection.join(type.ordered ? '→' : '-')}</td><td class="r tnum">${coins(t.stake)}</td>
                    <td class="r tnum">${atBuy} → ${fin}</td><td class="r tnum ${t.status === 'won' ? 'pos' : ''}">${t.status === 'open' ? '—' : coins(t.payout ?? 0)}</td></tr>`;
                })
                .join('')}</tbody></table></div>`
            : '<p class="muted">購入履歴はありません。</p>'
        }
      </section>`;

    el.querySelector('[data-refill]')?.addEventListener('click', async () => {
      store.set(await refill(store.state, store.now()));
      toast(`${coins(REFILL_AMOUNT)}コインを補充しました。`);
    });
  };
  return {
    title: '結果・収支',
    render(root) {
      el = root;
      draw();
    },
    update(reason) {
      if (reason === 'state') draw();
    },
  };
}
