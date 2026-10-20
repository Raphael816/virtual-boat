import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeRace, stText } from '../src/core/analysis';
import { buildCommentary } from '../src/core/commentary';
import { type RaceCard, createMeeting, runRace } from '../src/core/meeting';

let cards: RaceCard[];
beforeAll(async () => {
  cards = await createMeeting('analysis', () => 'seed-a');
});

describe('レース後の振り返り解説', () => {
  it('見出しに勝った艇と決まり手が含まれ、要点は1〜5件', () => {
    for (const c of cards) {
      const r = runRace(c, c.seed);
      const a = analyzeRace(c, r);
      expect(a.headline).toContain(`${c.entries[r.order[0]].number}号艇`);
      expect(a.headline).toContain(r.kimarite);
      expect(a.points.length).toBeGreaterThanOrEqual(1);
      expect(a.points.length).toBeLessThanOrEqual(5);
      expect(a.rows).toHaveLength(6);
    }
  });
  it('1番人気が負けた場合だけ敗因を述べる', () => {
    const c = cards[0];
    const r = runRace(c, c.seed);
    const winner = c.entries[r.order[0]].number;
    expect(analyzeRace(c, r, winner).favoriteNote).toBeNull();
    const loser = c.entries[r.order[r.order.length - 1]].number;
    expect(analyzeRace(c, r, loser).favoriteNote).toMatch('1番人気');
  });
  it('勝利を保証したり、投票を勧めたりする表現を含まない', () => {
    for (const c of cards) {
      const r = runRace(c, c.seed);
      const a = analyzeRace(c, r, 1);
      const text = [a.headline, ...a.points, a.favoriteNote ?? ''].join('');
      expect(text).not.toMatch(/必ず|確実|おすすめ|買い|狙い/);
    }
  });
  it('ST の表記（フライングは F）', () => {
    expect(stText(0.13)).toBe('.13');
    expect(stText(-0.02)).toBe('F.02');
  });
});

describe('実況', () => {
  it('時刻順で、スタートと1着のゴールと決まり手を含み、同じレースなら毎回同じ', () => {
    const c = cards[3];
    const r = runRace(c, c.seed);
    const a = buildCommentary(c, r);
    const b = buildCommentary(c, runRace(c, c.seed));
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i++) expect(a[i].t).toBeGreaterThanOrEqual(a[i - 1].t);
    expect(a.some((l) => l.text.includes('スタート'))).toBe(true);
    expect(a.some((l) => l.kind === 'finish' && l.text.includes(r.kimarite))).toBe(true);
  });
  it('欠場艇があれば返還を伝える', async () => {
    // フライングが起きる seed を探す
    for (const c of cards) {
      for (let k = 0; k < 60; k++) {
        const r = runRace(c, `fl${k}`);
        if (!r.excluded.length) continue;
        const lines = buildCommentary(c, r);
        expect(lines.some((l) => l.text.includes('返還'))).toBe(true);
        return;
      }
    }
  });
});
