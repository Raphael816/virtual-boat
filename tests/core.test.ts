import { describe, expect, it } from 'vitest';
import { Rng, sha256Hex } from '../src/core/rng';
import { BOAT_COLORS, RACERS } from '../src/data/racers';

describe('Rng', () => {
  it('同じシードから同じ系列を生成する', () => {
    const a = new Rng('race-1:seed');
    const b = new Rng('race-1:seed');
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()));
  });
  it('異なるシードでは系列が異なる', () => {
    expect(new Rng('a').next()).not.toBe(new Rng('b').next());
  });
  it('SHA-256 を計算できる', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('選手（架空）', () => {
  it('選手IDと名前が一意で、1開催の12レース×6艇をまかなえる人数がいる', () => {
    expect(new Set(RACERS.map((r) => r.id)).size).toBe(RACERS.length);
    expect(new Set(RACERS.map((r) => r.name)).size).toBe(RACERS.length);
    expect(RACERS.length * 3).toBeGreaterThanOrEqual(72);
  });
  it('能力値は 0〜100、平均STは現実的な範囲', () => {
    for (const r of RACERS) {
      for (const v of [r.start, r.turn, r.speed, r.wave]) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
      expect(r.avgST).toBeGreaterThan(0.1);
      expect(r.avgST).toBeLessThan(0.25);
    }
  });
  it('級別が上の選手ほど勝率が高い（平均）', () => {
    const avg = (g: string) => {
      const xs = RACERS.filter((r) => r.grade === g).map((r) => r.winRate);
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    expect(avg('A1')).toBeGreaterThan(avg('A2'));
    expect(avg('A2')).toBeGreaterThan(avg('B1'));
    expect(avg('B1')).toBeGreaterThan(avg('B2'));
  });
  it('艇番の色は6色', () => {
    expect(BOAT_COLORS).toHaveLength(6);
  });
});
