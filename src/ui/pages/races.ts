import { raceStatus } from '../../core/raceflow';
import { VENUE_NAME } from '../../data/racers';
import { type Page, conditionText, statusChip, statusOf, surfaceChip, timingText } from '../common';
import { store } from '../store';
import { coins } from '../util';

export function racesPage(): Page {
  let el: HTMLElement;

  const draw = () => {
    const m = store.state.meeting!;
    const now = store.now();
    const allDone = m.cards.every((c) => raceStatus(m.runtime[c.id], now) === 'finished');
    el.innerHTML = `
      <h1>レース一覧</h1>
      <p class="muted">${VENUE_NAME}（架空）・開催 ${m.id}。各レースは締切時刻になると自動で発走し、確定します（デモでは約4分間隔）。</p>
      ${allDone ? `<p class="notice notice-info" style="margin-bottom:12px">本日のレースはすべて確定しました。<button class="btn btn-sm" data-new style="margin-left:8px">新しい開催を始める</button></p>` : ''}
      <ul class="race-list">
        ${m.cards
          .map((c) => {
            const mine = store.state.tickets.filter((t) => t.raceId === c.id);
            const stake = mine.reduce((a, t) => a + t.stake, 0);
            return `<li class="race-item"><a href="#/race/${encodeURIComponent(c.id)}">
              <span class="race-no">${c.no}R</span>
              <span><b>${c.name}</b><br>
                <span class="race-meta">${surfaceChip(c)} ${conditionText(c)}</span>
                ${mine.length ? `<span class="race-meta">購入 ${mine.length}件・${coins(stake)}コイン</span>` : ''}
              </span>
              <span style="text-align:right">${statusChip(statusOf(c))}<br><small data-timing-id="${c.id}">${timingText(c)}</small></span>
            </a></li>`;
          })
          .join('')}
      </ul>`;
    el.querySelector('[data-new]')?.addEventListener('click', () => store.newMeeting());
  };

  return {
    title: 'レース一覧',
    render(root) {
      el = root;
      draw();
    },
    update(reason) {
      if (reason === 'state') return draw();
      if (reason === 'tick') {
        el.querySelectorAll<HTMLElement>('[data-timing-id]').forEach((n) => {
          const c = store.state.meeting!.cards.find((k) => k.id === n.dataset.timingId);
          if (c) n.innerHTML = timingText(c);
        });
      }
    },
  };
}
