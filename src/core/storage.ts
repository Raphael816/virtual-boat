/**
 * 端末内保存（localStorage）。読み書きに失敗する環境（プライベートモード等）では
 * メモリ上だけで動作する。
 */
import { type AppState, SCHEMA_VERSION } from './state';

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = 'virtual-boat:v1';

export function memoryKV(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

export function defaultKV(): KV {
  try {
    const probe = '__vt_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return memoryKV();
  }
}

export function loadState(kv: KV): AppState | null {
  try {
    const raw = kv.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as AppState;
    if (s.version !== SCHEMA_VERSION) return null; // 将来はここでマイグレーションする
    return s;
  } catch {
    return null;
  }
}

export function saveState(kv: KV, state: AppState): boolean {
  try {
    kv.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearState(kv: KV): void {
  try {
    kv.removeItem(KEY);
  } catch {
    /* noop */
  }
}
