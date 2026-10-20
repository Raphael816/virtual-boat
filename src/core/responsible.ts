/**
 * 責任ある利用のためのルール（デモ）。
 * - 1レース／1日あたりの投票上限、1日の損失上限
 * - 上限の引き下げは即時、引き上げは24時間後に反映（衝動的な緩和を防ぐ）
 * - 一時休止（24時間・7日）と自己排除（30日〜）は期限まで解除できない
 * - 利用時間のリマインダー
 */
import type { AppState } from './state';

export interface Limits {
  /** 1レースあたりの投票上限 */
  perRace: number;
  /** 1日あたりの投票上限 */
  daily: number;
  /** 1日の損失上限（到達するとその日は投票できない） */
  dailyLoss: number;
  /** 利用時間リマインダーの間隔（分） */
  sessionReminderMin: number;
}

/**
 * 投票上限（1レース・1日・損失）を適用するか。
 * デモでは一旦オフにしている。仕組みは残してあるので、true に戻せばすぐに有効になる。
 * 実際のお金を扱う場合は必ず有効にすること（docs/03-legal-and-safety.md）。
 */
export const BET_LIMITS_ENABLED = false;

/**
 * 一時休止・自己排除を適用するか。デモでは一旦オフにしている（設定画面にも表示しない）。
 * 保存済みの休止・自己排除の期限があっても、オフの間は投票を止めない。
 * 実際のお金を扱う場合は必ず有効にすること（docs/03-legal-and-safety.md）。
 */
export const SELF_EXCLUSION_ENABLED = false;

/** 休止・自己排除による投票の制限（なければ null） */
export function activeRestriction(state: AppState, ts: number, enabled = SELF_EXCLUSION_ENABLED): { code: 'self_excluded' | 'on_break'; until: number } | null {
  if (!enabled) return null;
  if (state.selfExcludedUntil && ts < state.selfExcludedUntil) return { code: 'self_excluded', until: state.selfExcludedUntil };
  if (state.breakUntil && ts < state.breakUntil) return { code: 'on_break', until: state.breakUntil };
  return null;
}

export const DEFAULT_LIMITS: Limits = { perRace: 3000, daily: 10000, dailyLoss: 5000, sessionReminderMin: 30 };
export const LIMIT_INCREASE_DELAY_MS = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export type CheckCode =
  | 'self_excluded'
  | 'on_break'
  | 'race_closed'
  | 'min_unit'
  | 'balance'
  | 'per_race'
  | 'daily'
  | 'daily_loss';

export type CheckResult = { ok: true } | { ok: false; code: CheckCode; message: string };

/** 端末のローカル日付（例: 2026-10-13） */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface DayStats {
  staked: number;
  returned: number;
  /** 確定済みの損益（払戻 − 確定済み投票額）。未確定の投票は含めない */
  settledNet: number;
  /** 未確定の投票額 */
  pending: number;
}

export function dayStats(state: AppState, ts: number): DayStats {
  const key = dayKey(ts);
  let staked = 0;
  let returned = 0;
  let settledStake = 0;
  let pending = 0;
  for (const t of state.tickets) {
    if (dayKey(t.ts) !== key) continue;
    staked += t.stake;
    if (t.status === 'open') pending += t.stake;
    else {
      settledStake += t.stake;
      returned += t.payout ?? 0;
    }
  }
  return { staked, returned, settledNet: returned - settledStake, pending };
}

export function raceStaked(state: AppState, raceId: string): number {
  return state.tickets.filter((t) => t.raceId === raceId).reduce((a, t) => a + t.stake, 0);
}

/** 有効な上限（反映待ちの引き上げが期限を過ぎていれば適用） */
export function effectiveLimits(state: AppState, ts: number): Limits {
  if (state.pendingLimits && ts >= state.pendingLimits.effectiveAt) return state.pendingLimits.limits;
  return state.limits;
}

export function checkBet(
  state: AppState,
  raceId: string,
  stake: number,
  ts: number,
  raceOpen: boolean,
  enforceLimits = BET_LIMITS_ENABLED,
  enforceExclusion = SELF_EXCLUSION_ENABLED,
): CheckResult {
  const r = activeRestriction(state, ts, enforceExclusion);
  if (r) {
    return {
      ok: false,
      code: r.code,
      message: `${r.code === 'self_excluded' ? '自己排除中' : '休止中'}のため、${fmtDate(r.until)}まで投票できません。`,
    };
  }
  if (!raceOpen) return { ok: false, code: 'race_closed', message: 'このレースの発売は締め切られました。' };
  if (!Number.isInteger(stake) || stake < 100 || stake % 100 !== 0) {
    return { ok: false, code: 'min_unit', message: '賭け金は100コイン単位で指定してください。' };
  }
  if (stake > state.balance) return { ok: false, code: 'balance', message: '残高が不足しています。' };
  if (!enforceLimits) return { ok: true };
  const lim = effectiveLimits(state, ts);
  if (raceStaked(state, raceId) + stake > lim.perRace) {
    return {
      ok: false,
      code: 'per_race',
      message: `1レースの投票上限（${lim.perRace.toLocaleString()}コイン）を超えます。残り ${Math.max(0, lim.perRace - raceStaked(state, raceId)).toLocaleString()}コイン。`,
    };
  }
  const st = dayStats(state, ts);
  if (st.staked + stake > lim.daily) {
    return {
      ok: false,
      code: 'daily',
      message: `本日の投票上限（${lim.daily.toLocaleString()}コイン）を超えます。残り ${Math.max(0, lim.daily - st.staked).toLocaleString()}コイン。`,
    };
  }
  // 未確定分はすべて外れた場合を想定して損失に含める（安全側）
  if (-(st.settledNet - st.pending) + stake > lim.dailyLoss) {
    return {
      ok: false,
      code: 'daily_loss',
      message: `本日の損失上限（${lim.dailyLoss.toLocaleString()}コイン）に達する可能性があるため、投票できません。`,
    };
  }
  return { ok: true };
}

export type LimitChange = { applied: 'now' } | { applied: 'later'; effectiveAt: number };

/** 上限変更。どれか1つでも引き上げがあれば全体を24時間後に反映、引き下げのみなら即時 */
export function changeLimits(state: AppState, next: Limits, ts: number): { state: AppState; change: LimitChange } {
  const cur = effectiveLimits(state, ts);
  const raises = next.perRace > cur.perRace || next.daily > cur.daily || next.dailyLoss > cur.dailyLoss;
  if (!raises) {
    return { state: { ...state, limits: next, pendingLimits: undefined }, change: { applied: 'now' } };
  }
  const effectiveAt = ts + LIMIT_INCREASE_DELAY_MS;
  // 引き下げた項目は待たずに即時反映する
  const immediate: Limits = {
    perRace: Math.min(cur.perRace, next.perRace),
    daily: Math.min(cur.daily, next.daily),
    dailyLoss: Math.min(cur.dailyLoss, next.dailyLoss),
    sessionReminderMin: next.sessionReminderMin,
  };
  return {
    state: { ...state, limits: immediate, pendingLimits: { limits: next, effectiveAt } },
    change: { applied: 'later', effectiveAt },
  };
}

/** 一時休止。既存の休止より短くすることはできない */
export function startBreak(state: AppState, hours: number, ts: number): AppState {
  const until = ts + hours * HOUR;
  return { ...state, breakUntil: Math.max(state.breakUntil ?? 0, until) };
}

/** 自己排除。期限前の解除はできない */
export function selfExclude(state: AppState, days: number, ts: number): AppState {
  if (days < 30) throw new Error('自己排除は30日以上で設定してください');
  const until = ts + days * DAY;
  return { ...state, selfExcludedUntil: Math.max(state.selfExcludedUntil ?? 0, until) };
}

/** 前回のリマインダーから設定時間が経過していれば true */
export function reminderDue(sessionStart: number, lastReminder: number | null, limits: Limits, ts: number): boolean {
  if (limits.sessionReminderMin <= 0) return false;
  const since = lastReminder ?? sessionStart;
  return ts - since >= limits.sessionReminderMin * 60 * 1000;
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
