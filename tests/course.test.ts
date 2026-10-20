import { describe, expect, it } from 'vitest';
import { DISTANCE, LAP, MARK_1, MARK_2, R0, SEGMENTS, START_TO_1M, STRAIGHT, WIDTH_AT_1M, lapPos, nextTurn, pointAt, widthAt } from '../src/core/course';

describe('江戸川を参考にした水面（非公式の再現）', () => {
  it('1周600m × 3周 = 1,800m', () => {
    expect(LAP).toBe(600);
    expect(DISTANCE).toBe(1800);
    expect(2 * STRAIGHT + 2 * Math.PI * R0).toBeCloseTo(LAP, 6);
  });
  it('1周で同じ点に戻り、区間の境目で座標が連続している', () => {
    const a = pointAt(0, 5);
    const b = pointAt(LAP, 5);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.z).toBeCloseTo(a.z, 6);
    for (const s of [SEGMENTS.turn1Start, SEGMENTS.turn1End, SEGMENTS.turn2Start, SEGMENTS.turn2End]) {
      const p = pointAt(s - 1e-6, 3);
      const q = pointAt(s + 1e-6, 3);
      expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeLessThan(1e-3);
    }
  });
  it('左回り：ターン中は進行方向が減っていく（上から見て反時計回り）', () => {
    const h1 = pointAt(SEGMENTS.turn1Start + 5, 0).heading;
    const h2 = pointAt(SEGMENTS.turn1Start + 20, 0).heading;
    expect(h2).toBeLessThan(h1);
  });
  it('1マークはスタンド側の直線の先にあり、ターンの中心から R0 + d の距離を回る', () => {
    const s = SEGMENTS.turn1Start + 10;
    const p = pointAt(s, 4);
    expect(Math.hypot(p.x - MARK_1.x, p.z - MARK_1.z)).toBeCloseTo(R0 + 4, 6);
    expect(MARK_1.x).toBeGreaterThan(MARK_2.x);
    expect(pointAt(10, 0).z).toBeGreaterThan(0); // ホームストレッチはスタンド側（+z）
  });
  it('スタートラインから1マークまで150m（推定）、1マーク付近の幅は約37m', () => {
    expect(START_TO_1M).toBe(150);
    expect(widthAt(SEGMENTS.turn1Start)).toBe(WIDTH_AT_1M);
    expect(widthAt(SEGMENTS.turn2Start)).toBeGreaterThan(WIDTH_AT_1M);
  });
  it('スタート前（s < 0）は直線の延長で、次のターンは1周目1マーク', () => {
    const p = pointAt(-50, 3);
    expect(p.onTurn).toBe(false);
    expect(nextTurn(-50)).toEqual({ dist: START_TO_1M + 50, index: 0 });
    expect(nextTurn(LAP + 10).index).toBe(2);
    expect(lapPos(-10)).toBeCloseTo(590);
  });
});
