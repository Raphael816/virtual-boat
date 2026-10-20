/**
 * 追記専用の監査ログ（ハッシュチェーン）。
 * hash_n = SHA-256(hash_{n-1} | seq | ts | type | data)
 * 途中の1件でも書き換えると、それ以降のハッシュが一致しなくなる。
 * 本番ではサーバー側の WORM ストレージに保存し、定期的に外部へアンカーする。
 */
import { sha256Hex } from './rng';

export type AuditType =
  | 'account_created'
  | 'race_open'
  | 'bet'
  | 'race_close'
  | 'race_result'
  | 'settle'
  | 'limits_change'
  | 'break'
  | 'self_exclusion'
  | 'refill'
  | 'refund';

export interface AuditEntry {
  seq: number;
  ts: number;
  type: AuditType;
  data: Record<string, unknown>;
  prev: string;
  hash: string;
}

export const GENESIS = '0'.repeat(64);

/** キー順を固定した JSON 文字列（ハッシュの再現性のため） */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

function entryPayload(e: Omit<AuditEntry, 'hash'>): string {
  return `${e.prev}|${e.seq}|${e.ts}|${e.type}|${stableStringify(e.data)}`;
}

export async function appendAudit(
  log: AuditEntry[],
  type: AuditType,
  data: Record<string, unknown>,
  ts: number,
): Promise<AuditEntry[]> {
  const last = log.at(-1);
  const base = { seq: (last?.seq ?? -1) + 1, ts, type, data, prev: last?.hash ?? GENESIS };
  return [...log, { ...base, hash: await sha256Hex(entryPayload(base)) }];
}

export interface AuditVerifyResult {
  ok: boolean;
  count: number;
  /** 最初に不整合が見つかった seq */
  brokenAt?: number;
}

export async function verifyAudit(log: AuditEntry[]): Promise<AuditVerifyResult> {
  let prev = GENESIS;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.seq !== i || e.prev !== prev) return { ok: false, count: log.length, brokenAt: e.seq };
    const h = await sha256Hex(entryPayload(e));
    if (h !== e.hash) return { ok: false, count: log.length, brokenAt: e.seq };
    prev = e.hash;
  }
  return { ok: true, count: log.length };
}
