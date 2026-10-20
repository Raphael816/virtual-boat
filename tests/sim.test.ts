import { beforeAll, describe, expect, it } from 'vitest';
import { DISTANCE } from '../src/core/course';
import { type RaceCard, commitInput, createMeeting, runRace, verifyRace } from '../src/core/meeting';
import { ENGINE_VERSION, LEAD, type RaceConditions, type SimBoat, formatRaceTime, sampleAt, simulateRace } from '../src/core/sim';
import { sha256Hex } from '../src/core/rng';
import { RACERS } from '../src/data/racers';

const COND: RaceConditions = { distance: DISTANCE, weather: 'sunny', wind: 1, wave: 3, tide: 'slack', timeOfDay: 'day' };
const motor = (power = 50) => ({ no: 11, rate: 33, power });
const field = (ids: number[], power = 50): SimBoat[] => ids.map((k, i) => ({ racer: RACERS[k], number: i + 1, motor: motor(power), boatNo: 20 + i }));

let cards: RaceCard[] = [];
beforeAll(async () => {
  for (let m = 0; m < 8; m++) cards.push(...(await createMeeting(`sim-${m}`, () => 'x')));
});

describe('simulateRace: 基本性質', () => {
  const boats = field([0, 5, 10, 15, 20, 25]);
  it('同じ seed なら完全に同じ結果（決定論的）', () => {
    const a = simulateRace(COND, boats, 's1');
    const b = simulateRace(COND, boats, 's1');
    expect(a.order).toEqual(b.order);
    expect(a.finishTimes).toEqual(b.finishTimes);
    expect(a.st).toEqual(b.st);
  });
  it('seed が違えば結果も変わりうる（意外性）', () => {
    const orders = new Set(Array.from({ length: 12 }, (_, i) => simulateRace(COND, boats, `v${i}`, { record: false }).order.join('')));
    expect(orders.size).toBeGreaterThan(3);
  });
  it('完走艇と欠場艇で全艇をちょうど1回ずつ含む', () => {
    for (let i = 0; i < 30; i++) {
      const r = simulateRace(COND, boats, `c${i}`, { record: false });
      expect([...r.order, ...r.excluded].sort()).toEqual([0, 1, 2, 3, 4, 5]);
      for (const k of r.excluded) expect(r.finishTimes[k]).toBe(Infinity);
    }
  });
  it('レースタイムが現実的な範囲（1,800m で 1分40秒〜1分55秒）', () => {
    for (let i = 0; i < 10; i++) {
      const r = simulateRace(COND, boats, `t${i}`, { record: false });
      const w = r.raceTimes[r.order[0]];
      expect(w).toBeGreaterThan(100);
      expect(w).toBeLessThan(115);
    }
  });
  it('記録モードと非記録モードで結果が一致する', () => {
    const a = simulateRace(COND, boats, 'r', { record: true });
    const b = simulateRace(COND, boats, 'r', { record: false });
    expect(a.order).toEqual(b.order);
    expect(a.kimarite).toBe(b.kimarite);
  });
  it('映像の時刻 LEAD がスタート合図。スタートタイミングで s=0 を通過する', () => {
    const r = simulateRace(COND, boats, 'st');
    const out: { x: number; lane: number; v: number }[] = [];
    for (let i = 0; i < 6; i++) {
      if (r.flags[i]) continue;
      sampleAt(r, LEAD + r.st[i], out);
      expect(Math.abs(out[i].x)).toBeLessThan(1.2);
    }
    sampleAt(r, r.finishTimes[r.order[0]], out);
    expect(out[r.order[0]].x).toBeCloseTo(DISTANCE, 0);
  });
});

describe('simulateRace: ボートレースらしい傾向（開催のレースで集計）', () => {
  it('1コースが最も勝ちやすいが、江戸川を参考に全国平均（約55%）より低い（40〜52%）', () => {
    const wins = [0, 0, 0, 0, 0, 0];
    let n = 0;
    for (const c of cards) {
      for (let k = 0; k < 2; k++) {
        const r = runRace(c, `w${k}`, { record: false });
        if (!r.order.length) continue;
        wins[c.entries[r.order[0]].number - 1]++;
        n++;
      }
    }
    const pct = wins.map((w) => (100 * w) / n);
    expect(pct[0]).toBeGreaterThan(40);
    expect(pct[0]).toBeLessThan(52);
    expect(pct[0]).toBeGreaterThan(Math.max(...pct.slice(1)));
    // 外のコースほど勝ちにくい（2〜4コース > 6コース）
    expect(Math.min(pct[1], pct[2], pct[3])).toBeGreaterThan(pct[5]);
  });
  it('決まり手は「逃げ」が最多で、差し・まくり・まくり差し・抜きも起こる', () => {
    const km: Record<string, number> = {};
    for (const c of cards) {
      const r = runRace(c, 'k', { record: false });
      if (r.order.length) km[r.kimarite] = (km[r.kimarite] ?? 0) + 1;
    }
    const top = Object.entries(km).sort((a, b) => b[1] - a[1])[0][0];
    expect(top).toBe('逃げ');
    for (const k of ['差し', 'まくり', 'まくり差し']) expect(km[k] ?? 0).toBeGreaterThan(0);
  });
  it('フライング・出遅れはまれに起こり、その艇は欠場（着順に含まれない）', () => {
    let ex = 0;
    let n = 0;
    for (const c of cards) {
      for (let k = 0; k < 4; k++) {
        const r = runRace(c, `f${k}`, { record: false });
        n++;
        ex += r.excluded.length;
        for (const i of r.excluded) {
          expect(r.flags[i] === 'F' ? r.st[i] < 0 : r.st[i] > 1).toBe(true);
          expect(r.order).not.toContain(i);
        }
      }
    }
    expect(ex / n).toBeLessThan(0.08);
  });
  it('モーターの性能が良いほど勝ちやすい（同じ選手どうしで比べる）', () => {
    const ids = [12, 12, 12, 12, 12, 12];
    let strong = 0;
    for (let i = 0; i < 80; i++) {
      const boats = field(ids).map((b, k) => ({ ...b, motor: motor(k === 2 ? 90 : 40) }));
      const r = simulateRace(COND, boats, `m${i}`, { record: false });
      if (r.order[0] === 2) strong++;
    }
    expect(strong / 80).toBeGreaterThan(0.2);
  });
  it('スタートが速い選手ほど1マークを先に回りやすい', () => {
    const ids = [12, 12, 12, 12, 12, 12];
    let early = 0;
    let late = 0;
    for (let i = 0; i < 60; i++) {
      const boats = field(ids).map((b, k) => ({ ...b, racer: { ...b.racer, avgST: k === 3 ? 0.1 : 0.2 } }));
      const r = simulateRace(COND, boats, `s${i}`, { record: false });
      if (r.factors[3].rankAfter1M === 1) early++;
      if (r.factors[4].rankAfter1M === 1) late++;
    }
    expect(early).toBeGreaterThan(late);
  });
});

describe('meeting: 開催生成とコミット・リビール', () => {
  it('1開催12レース・各6艇、選手は1日3走まで、艇番は1〜6', () => {
    const c = cards.slice(0, 12);
    expect(c).toHaveLength(12);
    const use = new Map<string, number>();
    for (const card of c) {
      expect(card.entries.map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(card.entries.map((e) => e.racerId)).size).toBe(6);
      for (const e of card.entries) {
        use.set(e.racerId, (use.get(e.racerId) ?? 0) + 1);
        expect(e.exhibition).toBeGreaterThan(6.4);
        expect(e.exhibition).toBeLessThan(7.2);
      }
    }
    expect(Math.max(...use.values())).toBeLessThanOrEqual(3);
  });
  it('同じ開催IDからは同じ出走表が生成される', async () => {
    const a = await createMeeting('same', () => 'x');
    const b = await createMeeting('same', () => 'x');
    expect(a.map((c) => c.entries)).toEqual(b.map((c) => c.entries));
    expect(a.map((c) => c.conditions)).toEqual(b.map((c) => c.conditions));
  });
  it('コミットは SHA-256(raceId|seed|engineVersion)', async () => {
    const [c] = await createMeeting('commit', () => 'seed-1');
    expect(c.commit).toBe(await sha256Hex(commitInput(c.id, 'seed-1', ENGINE_VERSION)));
  });
  it('公開された seed で結果を再現・検証でき、改ざんされた seed は検出される', async () => {
    const [c] = await createMeeting('verify', () => 'seed-v');
    const official = runRace(c, c.seed, { record: false });
    const ok = await verifyRace(c, 'seed-v');
    expect(ok.hashOk).toBe(true);
    expect(ok.order).toEqual(official.order.map((i) => c.entries[i].number));
    expect((await verifyRace(c, 'seed-x')).hashOk).toBe(false);
  });
});

describe('表示用ユーティリティ', () => {
  it('レースタイム表記', () => {
    expect(formatRaceTime(107.34)).toBe(`1'47"3`);
    expect(formatRaceTime(65.06)).toBe(`1'05"1`);
    expect(formatRaceTime(Infinity)).toBe('—');
  });
});
