/**
 * 利用者の状態（デモコイン台帳・投票券・上限・監査ログ）と、投票・払戻の処理。
 * すべて「状態を受け取り新しい状態を返す」純粋関数（監査ログのハッシュ計算のみ非同期）。
 *
 * デモコインは購入・換金・譲渡ができず、金銭的な価値はない。
 */
import { type AuditEntry, appendAudit } from './audit';
import { BET_TYPE_BY_ID, type BetTypeId, betKey, keyHasAny, validateSelection } from './bettypes';
import { type OddsBook, type Settlement, payout } from './pool';
import type { MeetingState } from './raceflow';
import { type CheckResult, DEFAULT_LIMITS, type Limits, activeRestriction, checkBet, dayKey } from './responsible';

export const SCHEMA_VERSION = 1;
export const INITIAL_GRANT = 10_000;
export const REFILL_AMOUNT = 5_000;
export const REFILL_THRESHOLD = 1_000;

export type LedgerKind = 'grant' | 'bet' | 'payout' | 'refill' | 'refund';

export interface LedgerEntry {
  id: string;
  ts: number;
  kind: LedgerKind;
  /** 増減額（投票はマイナス） */
  amount: number;
  balance: number;
  raceId?: string;
  ticketId?: string;
}

/** refunded：レースが実施されなかった（エンジン更新で開催を作り直した等）ため返還 */
export type TicketStatus = 'open' | 'won' | 'lost' | 'refunded';

export interface Ticket {
  id: string;
  ts: number;
  raceId: string;
  betType: BetTypeId;
  selection: number[];
  key: string;
  stake: number;
  /** 購入時点のオッズ（参考。払戻は確定オッズで計算） */
  oddsAtPurchase: number | null;
  /** 複勝・拡連複の購入時点の想定オッズ幅 */
  rangeAtPurchase?: [number, number] | null;
  status: TicketStatus;
  finalOdds?: number;
  payout?: number;
  settledAt?: number;
}

export interface AppState {
  version: number;
  createdAt: number;
  nickname: string;
  ageConfirmedAt?: number;
  balance: number;
  ledger: LedgerEntry[];
  tickets: Ticket[];
  limits: Limits;
  pendingLimits?: { limits: Limits; effectiveAt: number };
  breakUntil?: number;
  selfExcludedUntil?: number;
  lastRefillDay?: string;
  audit: AuditEntry[];
  /** 現在の開催（出走表・発売状況） */
  meeting?: MeetingState;
  /** 過去の開催も含むレースID → 表示名（収支画面用） */
  raceNames?: Record<string, string>;
}

let idCounter = 0;
/** 端末内で一意なID（時刻 + 連番 + 乱数） */
export function newId(prefix: string, ts: number): string {
  idCounter = (idCounter + 1) % 1e6;
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
  return `${prefix}_${ts.toString(36)}${idCounter.toString(36)}${rand}`;
}

export async function createInitialState(ts: number): Promise<AppState> {
  const base: AppState = {
    version: SCHEMA_VERSION,
    createdAt: ts,
    nickname: 'ゲスト',
    balance: INITIAL_GRANT,
    ledger: [{ id: newId('l', ts), ts, kind: 'grant', amount: INITIAL_GRANT, balance: INITIAL_GRANT }],
    tickets: [],
    limits: { ...DEFAULT_LIMITS },
    audit: [],
  };
  return { ...base, audit: await appendAudit([], 'account_created', { grant: INITIAL_GRANT }, ts) };
}

export interface BetRequest {
  raceId: string;
  betType: BetTypeId;
  selection: number[];
  stake: number;
}

export interface Quote {
  key: string;
  odds: number | null;
  range: [number, number] | null;
  /** 想定払戻額（複勝は幅） */
  estPayout: [number, number] | null;
  balanceAfter: number;
  check: CheckResult;
  selectionError: string | null;
}

/** 購入前の確認内容（現在のオッズ・想定払戻・購入後残高・上限チェック） */
export function quoteBet(
  state: AppState,
  req: BetRequest,
  numbers: number[],
  book: OddsBook,
  ts: number,
  raceOpen: boolean,
): Quote {
  const type = BET_TYPE_BY_ID[req.betType];
  const selectionError = validateSelection(type, req.selection, numbers);
  const key = selectionError ? '' : betKey(type, req.selection);
  const odds = key ? (book.odds[type.id][key] ?? null) : null;
  const range = type.poolKind === 'multi' && key ? (book.ranges[type.id]?.[key] ?? null) : null;
  let estPayout: [number, number] | null = null;
  if (range) estPayout = [payout(req.stake, range[0]), payout(req.stake, range[1])];
  else if (odds !== null) estPayout = [payout(req.stake, odds), payout(req.stake, odds)];
  return {
    key,
    odds,
    range,
    estPayout,
    balanceAfter: state.balance - req.stake,
    check: checkBet(state, req.raceId, req.stake, ts, raceOpen),
    selectionError,
  };
}

export type PlaceResult = { ok: true; state: AppState; ticket: Ticket } | { ok: false; message: string };

export async function placeBet(
  state: AppState,
  req: BetRequest,
  numbers: number[],
  book: OddsBook,
  ts: number,
  raceOpen: boolean,
): Promise<PlaceResult> {
  const q = quoteBet(state, req, numbers, book, ts, raceOpen);
  if (q.selectionError) return { ok: false, message: q.selectionError };
  if (!q.check.ok) return { ok: false, message: q.check.message };

  const ticket: Ticket = {
    id: newId('t', ts),
    ts,
    raceId: req.raceId,
    betType: req.betType,
    selection: [...req.selection],
    key: q.key,
    stake: req.stake,
    oddsAtPurchase: q.odds,
    rangeAtPurchase: q.range,
    status: 'open',
  };
  const balance = state.balance - req.stake;
  const entry: LedgerEntry = {
    id: newId('l', ts),
    ts,
    kind: 'bet',
    amount: -req.stake,
    balance,
    raceId: req.raceId,
    ticketId: ticket.id,
  };
  const audit = await appendAudit(
    state.audit,
    'bet',
    { ticket: ticket.id, race: req.raceId, type: req.betType, key: q.key, stake: req.stake, odds: q.odds },
    ts,
  );
  return {
    ok: true,
    ticket,
    state: { ...state, balance, tickets: [...state.tickets, ticket], ledger: [...state.ledger, entry], audit },
  };
}

/**
 * レース確定後の払戻。欠場艇を含む券と、不成立の券種の券は返還する。
 */
export async function settleRace(state: AppState, raceId: string, settlement: Settlement, ts: number): Promise<AppState> {
  let balance = state.balance;
  const ledger = [...state.ledger];
  let totalStake = 0;
  let totalPayout = 0;
  let totalRefund = 0;
  const tickets = state.tickets.map((t) => {
    if (t.raceId !== raceId || t.status !== 'open') return t;
    totalStake += t.stake;
    if (settlement.voidTypes.includes(t.betType) || keyHasAny(t.key, settlement.excluded)) {
      balance += t.stake;
      totalRefund += t.stake;
      ledger.push({ id: newId('l', ts), ts, kind: 'refund', amount: t.stake, balance, raceId, ticketId: t.id });
      return { ...t, status: 'refunded' as const, payout: t.stake, settledAt: ts };
    }
    const odds = settlement.odds[t.betType]?.[t.key];
    if (odds === undefined) return { ...t, status: 'lost' as const, payout: 0, settledAt: ts };
    const amount = payout(t.stake, odds);
    balance += amount;
    totalPayout += amount;
    ledger.push({ id: newId('l', ts), ts, kind: 'payout', amount, balance, raceId, ticketId: t.id });
    return { ...t, status: 'won' as const, finalOdds: odds, payout: amount, settledAt: ts };
  });
  if (totalStake === 0) return state;
  const audit = await appendAudit(
    state.audit,
    'settle',
    { race: raceId, stake: totalStake, payout: totalPayout, refund: totalRefund, excluded: settlement.excluded, void: settlement.voidTypes },
    ts,
  );
  return { ...state, balance, tickets, ledger, audit };
}

/**
 * 指定したレースの未確定の券を返還する（賭け金をそのまま戻す）。
 * シミュレーションのエンジンが更新されて、保存済みの開催を同じ結果で再現できなくなった場合などに使う。
 */
export async function refundRaces(state: AppState, raceIds: string[], ts: number, reason: string): Promise<AppState> {
  const ids = new Set(raceIds);
  let balance = state.balance;
  const ledger = [...state.ledger];
  let total = 0;
  const tickets = state.tickets.map((t) => {
    if (!ids.has(t.raceId) || t.status !== 'open') return t;
    balance += t.stake;
    total += t.stake;
    ledger.push({ id: newId('l', ts), ts, kind: 'refund', amount: t.stake, balance, raceId: t.raceId, ticketId: t.id });
    return { ...t, status: 'refunded' as const, payout: t.stake, settledAt: ts };
  });
  if (total === 0) return state;
  const audit = await appendAudit(state.audit, 'refund', { races: raceIds, amount: total, reason }, ts);
  return { ...state, balance, tickets, ledger, audit };
}

/** 残高が少ないときの補充（1日1回・休止中や自己排除中は不可） */
export function canRefill(state: AppState, ts: number): boolean {
  if (state.balance >= REFILL_THRESHOLD) return false;
  if (state.lastRefillDay === dayKey(ts)) return false;
  if (activeRestriction(state, ts)) return false;
  return true;
}

export async function refill(state: AppState, ts: number): Promise<AppState> {
  if (!canRefill(state, ts)) return state;
  const balance = state.balance + REFILL_AMOUNT;
  return {
    ...state,
    balance,
    lastRefillDay: dayKey(ts),
    ledger: [...state.ledger, { id: newId('l', ts), ts, kind: 'refill', amount: REFILL_AMOUNT, balance }],
    audit: await appendAudit(state.audit, 'refill', { amount: REFILL_AMOUNT }, ts),
  };
}

export interface RaceSummary {
  raceId: string;
  stake: number;
  payout: number;
  net: number;
  tickets: number;
  hits: number;
  settled: boolean;
}

/** レース別収支（新しい順） */
export function raceSummaries(state: AppState): RaceSummary[] {
  const map = new Map<string, RaceSummary>();
  for (const t of state.tickets) {
    const s = map.get(t.raceId) ?? { raceId: t.raceId, stake: 0, payout: 0, net: 0, tickets: 0, hits: 0, settled: true };
    s.stake += t.stake;
    s.payout += t.payout ?? 0;
    s.tickets++;
    if (t.status === 'won') s.hits++;
    if (t.status === 'open') s.settled = false;
    s.net = s.payout - s.stake;
    map.set(t.raceId, s);
  }
  const lastTs = (id: string) => Math.max(...state.tickets.filter((t) => t.raceId === id).map((t) => t.ts));
  return [...map.values()].sort((a, b) => lastTs(b.raceId) - lastTs(a.raceId));
}
