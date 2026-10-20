import { BET_LIMITS_ENABLED, activeRestriction, dayStats, effectiveLimits } from '../../core/responsible';
import { VENUE_NAME } from '../../data/racers';
import {
  type Page,
  conditionText,
  nextOpenRace,
  raceTitle,
  statusChip,
  statusOf,
  surfaceChip,
  timingText,
} from '../common';
import { store } from '../store';
import { coins, signClass, signed } from '../util';

export function homePage(): Page {
  let el: HTMLElement;

  const draw = () => {
    const s = store.state;
    const now = store.now();
    const st = dayStats(s, now);
    const lim = effectiveLimits(s, now);
    const next = nextOpenRace();
    const isNew = s.tickets.length === 0;
    const restricted = activeRestriction(s, now) !== null;

    el.innerHTML = `
      <h1 class="sr-only">Virtual Boat トップ</h1>
      ${restricted ? `<p class="notice" style="margin-bottom:12px">現在、休止または自己排除の期間中です。観戦はできますが投票はできません。</p>` : ''}
      <section class="hero">
        <div class="card next-race" aria-labelledby="next-h">
          <p class="muted" style="margin:0">${VENUE_NAME}（架空）</p>
          ${
            next
              ? `<h2 id="next-h" class="title">${raceTitle(next)}</h2>
                 <p class="race-meta">${surfaceChip(next)} ${statusChip(statusOf(next))} ${conditionText(next)}</p>
                 <p data-timing style="font-size:1.1rem">${timingText(next)}</p>
                 <a class="btn btn-primary" href="#/race/${encodeURIComponent(next.id)}">出走表・観戦へ</a>`
              : `<h2 id="next-h" class="title">本日のレースはすべて確定しました</h2>
                 <p>結果や収支を振り返るか、新しい開催を始められます。</p>
                 <div class="btn-row"><a class="btn" href="#/history">収支を見る</a><button class="btn btn-primary" data-new>新しい開催を始める</button></div>`
          }
        </div>
        <div class="card" aria-labelledby="wallet-h">
          <h2 id="wallet-h">デモコイン</h2>
          <div class="grid grid-2">
            <div class="stat"><span class="label">残高</span><span class="value">${coins(s.balance)}</span></div>
            <div class="stat"><span class="label">本日の収支（確定分）</span><span class="value ${signClass(st.settledNet)}">${signed(st.settledNet)}</span></div>
            ${
              BET_LIMITS_ENABLED
                ? `<div class="stat"><span class="label">本日の投票額 / 上限</span><span class="value" style="font-size:1rem">${coins(st.staked)} / ${coins(lim.daily)}</span></div>
                   <div class="stat"><span class="label">1レースの上限</span><span class="value" style="font-size:1rem">${coins(lim.perRace)}</span></div>`
                : `<div class="stat"><span class="label">本日の投票額</span><span class="value" style="font-size:1rem">${coins(st.staked)}</span></div>
                   <div class="stat"><span class="label">投票上限</span><span class="value" style="font-size:1rem">なし</span></div>`
            }
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:.85rem">デモコインに金銭的な価値はなく、購入も換金もできません。</p>
        </div>
      </section>

      ${
        isNew
          ? `<section class="card" style="margin-top:16px" aria-labelledby="first-h">
              <h2 id="first-h">はじめての方へ — 3ステップで遊べます</h2>
              <ol class="steps">
                <li><div><b>出走表を検討する</b><br><span class="muted">選手の級別・勝率・平均ST、モーター、展示タイム、潮・風・波とオッズを見比べます。</span></div></li>
                <li><div><b>デモコインで投票する</b><br><span class="muted">3連単・2連単など7つの券種。はじめは1艇を選ぶ「単勝」「複勝」もおすすめです。</span></div></li>
                <li><div><b>3Dで観戦して振り返る</b><br><span class="muted">レース後に勝因の解説と収支が表示されます。</span></div></li>
              </ol>
              <p style="margin:12px 0 0"><a href="#/guide">遊び方・オッズの仕組みを詳しく見る →</a></p>
            </section>`
          : ''
      }

      <section style="margin-top:16px" aria-labelledby="list-h">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <h2 id="list-h">本日のレース</h2><a href="#/races">すべて見る</a>
        </div>
        <ul class="race-list">
          ${s
            .meeting!.cards.map(
              (c) => `<li class="race-item"><a href="#/race/${encodeURIComponent(c.id)}">
                <span class="race-no">${c.no}R</span>
                <span><b>${c.name}</b><br><span class="race-meta">${surfaceChip(c)} ${conditionText(c)}</span></span>
                <span style="text-align:right">${statusChip(statusOf(c))}<br><small data-timing-id="${c.id}">${timingText(c)}</small></span>
              </a></li>`,
            )
            .join('')}
        </ul>
      </section>`;

    el.querySelector('[data-new]')?.addEventListener('click', async () => {
      await store.newMeeting();
    });
  };

  return {
    title: 'トップ',
    render(root) {
      el = root;
      draw();
    },
    update(reason) {
      if (reason === 'state') return draw();
      if (reason === 'tick') {
        const next = nextOpenRace();
        const t = el.querySelector('[data-timing]');
        if (t && next) t.innerHTML = timingText(next);
        el.querySelectorAll<HTMLElement>('[data-timing-id]').forEach((n) => {
          const c = store.state.meeting!.cards.find((k) => k.id === n.dataset.timingId);
          if (c) n.innerHTML = timingText(c);
        });
      }
    },
  };
}
