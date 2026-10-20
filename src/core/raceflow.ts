/**
 * レースの進行管理：発売 → 締切（オッズ確定）→ 発走 → 確定（seed の公開・払戻）。
 *
 * 時刻はすべて引数で受け取るため、テストでは任意の時刻を与えられる。
 * 利用者が画面を開いていない間に締切を過ぎたレースも、次に開いたときに同じ結果で確定する。
 */
import { appendAudit } from './audit';
import type { BetTypeId } from './bettypes';
import { type RaceCard, runRace } from './meeting';
import { LEAD } from './sim';
import { type Pools, type Settlement, buildOddsBook, marketPools, poolTotal, settleOdds, withStakes } from './pool';
import type { Probabilities } from './probability';
import { type AppState, settleRace } from './state';

/** デモ用の発売時間：最初のレースは開催開始の5分後、以降4分間隔 */
export const FIRST_CLOSE_MS = 5 * 60 * 1000;
export const CLOSE_INTERVAL_MS = 4 * 60 * 1000;
/** 締切から映像開始までの演出時間（映像は待機行動・スタート展示から始まる） */
export const GATE_LOADING_MS = 3000;
/** オッズが更新される間隔 */
export const ODDS_TICK_MS = 10_000;

export type RaceStatus = 'open' | 'closed' | 'running' | 'finished';

export const STATUS_LABEL: Record<RaceStatus, string> = {
  open: '発売中',
  closed: '締切',
  running: '発走',
  finished: '確定',
};

export interface RaceRuntime {
  openedAt: number;
  closesAt: number;
  closedAt?: number;
  /** 締切時点で確定したプール */
  finalPools?: Pools;
  startsAt?: number;
  endsAt?: number;
  /** 確定着順（完走艇の艇番） */
  order?: number[];
  /** 払戻（的中キーと確定オッズ・返還） */
  settlement?: Settlement;
  finishedAt?: number;
}

export interface MeetingState {
  id: string;
  createdAt: number;
  cards: RaceCard[];
  runtime: Record<string, RaceRuntime>;
}

export function raceStatus(rt: RaceRuntime, now: number): RaceStatus {
  if (rt.finishedAt !== undefined) return 'finished';
  if (rt.closedAt === undefined) return now < rt.closesAt ? 'open' : 'closed';
  if (rt.startsAt !== undefined && now >= rt.startsAt) return 'running';
  return 'closed';
}

export function cardOf(meeting: MeetingState, raceId: string): RaceCard {
  const c = meeting.cards.find((k) => k.id === raceId);
  if (!c) throw new Error(`unknown race ${raceId}`);
  return c;
}

export async function openMeeting(state: AppState, meetingId: string, cards: RaceCard[], now: number): Promise<AppState> {
  const runtime: Record<string, RaceRuntime> = {};
  let audit = state.audit;
  for (const c of cards) {
    runtime[c.id] = { openedAt: now, closesAt: now + FIRST_CLOSE_MS + (c.no - 1) * CLOSE_INTERVAL_MS };
    audit = await appendAudit(audit, 'race_open', { race: c.id, commit: c.commit, engine: c.engineVersion }, now);
  }
  const raceNames = { ...state.raceNames };
  for (const c of cards) raceNames[c.id] = `${c.no}R ${c.name}`;
  return { ...state, audit, raceNames, meeting: { id: meetingId, createdAt: now, cards, runtime } };
}

/** 発売の進み具合（0.25 で始まり、締切で 1） */
export function marketProgress(rt: RaceRuntime, now: number): number {
  const span = Math.max(1, rt.closesAt - rt.openedAt);
  return Math.min(1, 0.25 + (0.75 * Math.max(0, now - rt.openedAt)) / span);
}

export function oddsTick(rt: RaceRuntime, now: number): number {
  return Math.floor(Math.max(0, Math.min(now, rt.closesAt) - rt.openedAt) / ODDS_TICK_MS);
}

/** 現在のプール（締切後は確定プール） */
export function currentPools(state: AppState, card: RaceCard, probs: Probabilities, now: number): Pools {
  const rt = state.meeting!.runtime[card.id];
  if (rt.finalPools) return rt.finalPools;
  const numbers = card.entries.map((e) => e.number);
  const market = marketPools(card.id, numbers, probs, marketProgress(rt, now), oddsTick(rt, now));
  return withStakes(market, state.tickets.filter((t) => t.raceId === card.id));
}

export function currentOddsBook(state: AppState, card: RaceCard, probs: Probabilities, now: number) {
  return buildOddsBook(
    currentPools(state, card, probs, now),
    card.entries.map((e) => e.number),
  );
}

function patchRuntime(state: AppState, raceId: string, patch: Partial<RaceRuntime>): AppState {
  const m = state.meeting!;
  return { ...state, meeting: { ...m, runtime: { ...m.runtime, [raceId]: { ...m.runtime[raceId], ...patch } } } };
}

/** 締切：プールを確定し、発走時刻と終了時刻を決める（デモでは締切を早めることもできる） */
export async function closeRace(state: AppState, raceId: string, probs: Probabilities, now: number): Promise<AppState> {
  const m = state.meeting!;
  const rt = m.runtime[raceId];
  if (rt.closedAt !== undefined) return state;
  const card = cardOf(m, raceId);
  const closedAt = Math.min(now, rt.closesAt);
  const numbers = card.entries.map((e) => e.number);
  const finalPools = withStakes(
    marketPools(card.id, numbers, probs, 1, oddsTick(rt, closedAt)),
    state.tickets.filter((t) => t.raceId === raceId),
  );
  const times = runRace(card, card.seed, { record: false }).finishTimes.filter(Number.isFinite);
  const duration = Math.max(LEAD, ...times) + 3;
  const startsAt = closedAt + GATE_LOADING_MS;
  const endsAt = startsAt + duration * 1000;
  const totals = Object.fromEntries(Object.keys(finalPools).map((t) => [t, poolTotal(finalPools, t as BetTypeId)]));
  const next = patchRuntime(state, raceId, { closedAt, closesAt: closedAt, finalPools, startsAt, endsAt });
  return { ...next, audit: await appendAudit(next.audit, 'race_close', { race: raceId, totals }, closedAt) };
}

/** 確定：公式シミュレーションの着順で払戻を計算し、seed を公開する */
export async function finishRace(state: AppState, raceId: string, now: number): Promise<AppState> {
  const m = state.meeting!;
  const rt = m.runtime[raceId];
  if (rt.finishedAt !== undefined || !rt.finalPools || rt.endsAt === undefined) return state;
  const card = cardOf(m, raceId);
  const res = runRace(card, card.seed, { record: false });
  const order = res.order.map((i) => card.entries[i].number);
  const excluded = res.excluded.map((i) => card.entries[i].number);
  const settlement = settleOdds(rt.finalPools, order, excluded);
  const finishedAt = Math.max(now, rt.endsAt);
  let next = patchRuntime(state, raceId, { order, settlement, finishedAt });
  next = {
    ...next,
    audit: await appendAudit(
      next.audit,
      'race_result',
      { race: raceId, order, excluded, seed: card.seed, commit: card.commit },
      finishedAt,
    ),
  };
  return settleRace(next, raceId, settlement, finishedAt);
}

/**
 * 時刻 now までに締切・確定すべきレースを処理する。
 * getProbs はオッズ推定用の確率（重い計算なので呼び出し側でキャッシュする）。
 */
export async function advance(state: AppState, now: number, getProbs: (card: RaceCard) => Probabilities): Promise<AppState> {
  if (!state.meeting) return state;
  let s = state;
  for (const card of [...s.meeting!.cards].sort((a, b) => a.no - b.no)) {
    let rt = s.meeting!.runtime[card.id];
    if (rt.closedAt === undefined && now >= rt.closesAt) {
      s = await closeRace(s, card.id, getProbs(card), rt.closesAt);
      rt = s.meeting!.runtime[card.id];
    }
    if (rt.finishedAt === undefined && rt.endsAt !== undefined && now >= rt.endsAt) {
      s = await finishRace(s, card.id, rt.endsAt);
    }
  }
  return s;
}
