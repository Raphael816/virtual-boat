import { BOAT_COLORS } from '../data/racers';

/** HTML エスケープ（利用者が入力した文字列は必ず通す） */
export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export const coins = (n: number): string => `${Math.round(n).toLocaleString('ja-JP')}`;

export function signed(n: number): string {
  if (n === 0) return '±0';
  return `${n > 0 ? '+' : '−'}${coins(Math.abs(n))}`;
}

export function signClass(n: number): string {
  return n > 0 ? 'pos' : n < 0 ? 'neg' : '';
}

export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function dateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${clock(ts)}`;
}

/** 艇番の色つきバッジ（1白・2黒・3赤・4青・5黄・6緑） */
export function numBadge(number: number, extra = ''): string {
  const c = BOAT_COLORS[(number - 1) % 6];
  return `<span class="num ${extra}" style="--nb:${c.bg};--nf:${c.fg}" aria-label="${number}号艇">${number}</span>`;
}

export function $(root: ParentNode, sel: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`not found: ${sel}`);
  return el;
}

export function $$<T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

let toastTimer = 0;
export function toast(message: string, kind: 'info' | 'warn' = 'info'): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 4000);
}

/** フォーカスを閉じ込めるモーダルダイアログ（<dialog> を利用） */
export function openDialog(html: string, opts: { label: string; onClose?: () => void } = { label: 'ダイアログ' }): HTMLDialogElement {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  dlg.setAttribute('aria-label', opts.label);
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => {
    dlg.remove();
    opts.onClose?.();
  });
  dlg.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest('[data-close]')) dlg.close();
  });
  dlg.showModal();
  return dlg;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
