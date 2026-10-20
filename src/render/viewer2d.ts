/**
 * 2D 上空図（3D が使えない環境、または利用者が選んだ場合の代替表示）。
 * Canvas に水面・ターンマーク・スタートラインと各艇の位置を描く。
 */
import { MARK_1, MARK_2, R0, START_X, WIDTH, WIDTH_AT_1M, pointAt } from '../core/course';
import type { RaceCard } from '../core/meeting';
import { BOAT_COLORS } from '../data/racers';
import type { BoatFrame, CameraMode, RaceViewer } from './types';

/** 表示範囲（助走の分だけ 2マーク側を広めに取る） */
const BOUNDS = { minX: MARK_2.x - R0 - 40, maxX: MARK_1.x + R0 + WIDTH_AT_1M, minZ: -R0 - WIDTH, maxZ: R0 + WIDTH + 18 };
const MID = { x: (BOUNDS.minX + BOUNDS.maxX) / 2, z: (BOUNDS.minZ + BOUNDS.maxZ) / 2 };

export class Viewer2D implements RaceViewer {
  readonly kind = '2d' as const;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private container: HTMLElement | null = null;
  private baseScale = 1;
  private scale = 1;
  private dpr = 1;
  private follow = -1;
  private mode: CameraMode = 'overview';
  private center = { ...MID };

  mount(container: HTMLElement): void {
    this.container = container;
    this.canvas.className = 'viewer-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '水面の上空図。各艇の位置を表示しています');
    container.appendChild(this.canvas);
    this.resize();
  }

  setRace(_card: RaceCard): void {}

  /** 全景以外のカメラでは、先頭（または注目艇）を中心に拡大する */
  setCamera(mode: CameraMode, followIndex?: number): void {
    this.mode = mode;
    this.follow = followIndex ?? -1;
  }

  resize(): void {
    if (!this.container) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const halfW = (BOUNDS.maxX - BOUNDS.minX) / 2;
    const halfH = (BOUNDS.maxZ - BOUNDS.minZ) / 2;
    this.baseScale = Math.min(this.canvas.width / (2 * halfW), this.canvas.height / (2 * halfH));
    this.scale = this.baseScale;
  }

  private toScreen(x: number, z: number): [number, number] {
    return [this.canvas.width / 2 + (x - this.center.x) * this.scale, this.canvas.height / 2 + (z - this.center.z) * this.scale];
  }

  render(_time: number, boats: BoatFrame[]): void {
    const ctx = this.ctx;
    const { width, height } = this.canvas;

    if (this.mode === 'overview' || boats.length === 0) {
      this.scale = this.baseScale;
      this.center = { ...MID };
    } else {
      const racing = boats.filter((b) => !b.out);
      const target =
        boats.find((b) => b.index === this.follow && this.mode === 'follow') ??
        (racing.length ? racing : boats).reduce((a, b) => (b.rank < a.rank ? b : a));
      const p = pointAt(target.x, target.lane);
      const k = 0.12;
      this.center = { x: this.center.x + (p.x - this.center.x) * k, z: this.center.z + (p.z - this.center.z) * k };
      this.scale = this.baseScale * 2.6;
    }

    // 岸（スタンド側の手前と対岸）と水面
    ctx.fillStyle = '#2b3a2e';
    ctx.fillRect(0, 0, width, height);
    const [, wTop] = this.toScreen(0, -R0 - WIDTH - 8);
    const [, wBot] = this.toScreen(0, R0 + WIDTH + 2);
    const grad = ctx.createLinearGradient(0, wTop, 0, wBot);
    grad.addColorStop(0, '#1d4a66');
    grad.addColorStop(1, '#2a6a88');
    ctx.fillStyle = grad;
    ctx.fillRect(0, wTop, width, wBot - wTop);

    // スタンド
    ctx.fillStyle = '#4a5664';
    const [sx0, sy0] = this.toScreen(START_X - 150, R0 + WIDTH + 4);
    ctx.fillRect(sx0, sy0, 260 * this.scale, 12 * this.scale);

    // 周回の目安（内側の線）
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let s = 0; s <= 600; s += 4) {
      const p = pointAt(s, 0);
      const [x, y] = this.toScreen(p.x, p.z);
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    // スタートライン（ゴールライン）
    const [lx, ly0] = this.toScreen(START_X, R0 - 2);
    const [, ly1] = this.toScreen(START_X, R0 + WIDTH);
    ctx.strokeStyle = '#f2f2f2';
    ctx.lineWidth = Math.max(2, 0.6 * this.scale);
    ctx.beginPath();
    ctx.moveTo(lx, ly0);
    ctx.lineTo(lx, ly1);
    ctx.stroke();

    // ターンマーク
    for (const m of [MARK_1, MARK_2]) {
      const [mx, my] = this.toScreen(m.x, m.z);
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(4 * this.dpr, 1.6 * this.scale), 0, Math.PI * 2);
      ctx.fillStyle = '#ff7a1a';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // 艇（後ろの順位から描いて、先頭を上に重ねる）
    const r = Math.max(7 * this.dpr, 1.6 * this.scale);
    const sorted = [...boats].sort((a, b) => b.rank - a.rank);
    ctx.font = `bold ${Math.round(r * 1.1)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const b of sorted) {
      const p = pointAt(b.x, b.lane);
      const [x, y] = this.toScreen(p.x, p.z);
      const c = BOAT_COLORS[(b.number - 1) % 6];
      // 引き波（進行方向の後ろに白い線）
      if (b.v > 3) {
        ctx.strokeStyle = 'rgba(255,255,255,.55)';
        ctx.lineWidth = Math.max(1.5, 0.5 * this.scale);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(p.heading) * r * 2.6, y - Math.sin(p.heading) * r * 2.6);
        ctx.stroke();
      }
      ctx.globalAlpha = b.out ? 0.45 : 1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = c.bg;
      ctx.fill();
      ctx.lineWidth = b.index === this.follow ? 3 : 1.2;
      ctx.strokeStyle = b.index === this.follow ? '#ffd166' : b.number === 1 ? '#555' : '#0b1622';
      ctx.stroke();
      ctx.fillStyle = c.fg;
      ctx.fillText(String(b.number), x, y + 0.5);
      ctx.globalAlpha = 1;
    }
  }

  dispose(): void {
    this.canvas.remove();
    this.container = null;
  }
}
