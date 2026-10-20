import type { RaceCard, RaceEntry } from '../core/meeting';
import { type RaceRuntime, type RaceStatus, STATUS_LABEL, raceStatus } from '../core/raceflow';
import { TIDE_LABEL, TIME_LABEL, WEATHER_LABEL } from '../core/sim';
import { type Racer, RACER_BY_ID } from '../data/racers';
import { store } from './store';
import { countdown, esc } from './util';

export interface Page {
  title: string;
  render(el: HTMLElement): void;
  /** state: 状態変化 / tick: 1秒ごと / probs: 確率推定の完了 */
  update?(reason: 'state' | 'tick' | 'probs'): void;
  dispose?(): void;
}

export const racerOf = (e: RaceEntry): Racer => RACER_BY_ID.get(e.racerId)!;

export function runtimeOf(card: RaceCard): RaceRuntime {
  return store.state.meeting!.runtime[card.id];
}

export function statusOf(card: RaceCard): RaceStatus {
  return raceStatus(runtimeOf(card), store.now());
}

export function statusChip(status: RaceStatus): string {
  return `<span class="chip chip-${status}">${STATUS_LABEL[status]}</span>`;
}

export function surfaceChip(card: RaceCard): string {
  const c = card.conditions;
  return `<span class="chip chip-${c.tide}">${TIDE_LABEL[c.tide]}</span>`;
}

/** 風向き：ホームストレッチの進行方向（スタート→1マーク）への風を「追い風」とする */
export function windText(wind: number): string {
  if (wind === 0) return '無風';
  return `${wind > 0 ? '追い風' : '向かい風'}${Math.abs(wind)}m`;
}

export function conditionText(card: RaceCard): string {
  const c = card.conditions;
  return `${WEATHER_LABEL[c.weather]}・${windText(c.wind)}・波${c.wave}cm・${TIDE_LABEL[c.tide]}・${TIME_LABEL[c.timeOfDay]}・${c.distance}m`;
}

/** 状態に応じた時刻表示（締切まで／発走まで／確定） */
export function timingText(card: RaceCard): string {
  const rt = runtimeOf(card);
  const now = store.now();
  switch (raceStatus(rt, now)) {
    case 'open':
      return `締切まで <b class="tnum">${countdown(rt.closesAt - now)}</b>`;
    case 'closed':
      return rt.startsAt ? `発走まで <b class="tnum">${countdown(rt.startsAt - now)}</b>` : '締切処理中';
    case 'running':
      return '<b>レース中</b>';
    case 'finished':
      return '確定';
  }
}

export function raceTitle(card: RaceCard): string {
  return `${card.no}R ${esc(card.name)}`;
}

export function nextOpenRace(): RaceCard | undefined {
  const m = store.state.meeting;
  if (!m) return undefined;
  const now = store.now();
  return (
    m.cards.find((c) => ['running', 'closed'].includes(raceStatus(m.runtime[c.id], now))) ??
    m.cards.find((c) => raceStatus(m.runtime[c.id], now) === 'open')
  );
}

export const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  races: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19V5M4 19h16M8 15l3-4 3 2 5-6"/></svg>',
  guide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01"/></svg>',
  account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
};
