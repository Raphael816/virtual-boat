import { stText } from '../../core/analysis';
import { raceStatus } from '../../core/raceflow';
import { RACER_BY_ID, type Racer } from '../../data/racers';
import { type Page, conditionText, raceTitle, surfaceChip } from '../common';
import { store } from '../store';
import { esc, numBadge } from '../util';

const STATS: { key: keyof Pick<Racer, 'start' | 'turn' | 'speed' | 'wave'>; label: string; help: string }[] = [
  { key: 'start', label: 'スタート', help: 'スタートタイミングの安定度' },
  { key: 'turn', label: 'ターン', help: '旋回の速さ・流れにくさ' },
  { key: 'speed', label: '伸び', help: '直線の速さ（モーターの出し方）' },
  { key: 'wave', label: '波への強さ', help: '荒れた水面でのターンの安定' },
];

/** 能力値のレーダーチャート（SVG） */
function radar(values: number[], labels: string[]): string {
  const size = 240;
  const c = size / 2;
  const R = 84;
  const pt = (i: number, v: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / values.length;
    const r = (R * Math.max(0, v - 30)) / 70; // 30〜100 を 0〜R に対応
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  const rings = [50, 70, 90, 100]
    .map((v) => `<polygon points="${values.map((_, i) => pt(i, v).join(',')).join(' ')}" fill="none" stroke="var(--border)"/>`)
    .join('');
  const poly = values.map((v, i) => pt(i, v).join(',')).join(' ');
  const text = labels
    .map((l, i) => {
      const [x, y] = pt(i, 118);
      return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${l} ${values[i]}</text>`;
    })
    .join('');
  return `<svg class="radar" viewBox="-36 -6 ${size + 72} ${size + 12}" width="100%" style="max-width:300px" role="img" aria-label="能力値: ${labels.map((l, i) => `${l}${values[i]}`).join('、')}">
    ${rings}<polygon points="${poly}" fill="rgba(56,150,220,.3)" stroke="var(--turf)" stroke-width="2"/>${text}</svg>`;
}

export function racerPage(racerId: string): Page {
  const r = RACER_BY_ID.get(racerId);
  if (!r) return { title: '選手が見つかりません', render: (el) => (el.innerHTML = '<h1>選手が見つかりません</h1><p><a href="#/races">レース一覧へ</a></p>') };

  return {
    title: r.name,
    render(el) {
      const m = store.state.meeting!;
      const now = store.now();
      const entries = m.cards
        .map((c) => ({ c, e: c.entries.find((e) => e.racerId === r.id) }))
        .filter((x) => x.e);
      const motor = entries[0]?.e?.motor;
      el.innerHTML = `
        <p style="margin-bottom:4px"><button type="button" class="btn btn-sm" data-back>← 戻る</button></p>
        <h1>${esc(r.name)}</h1>
        <p class="muted"><span class="grade grade-${r.grade}">${r.grade}</span> ${esc(r.branch)}支部・${r.age}歳・${r.weight.toFixed(1)}kg（架空の選手）</p>
        <div class="grid grid-2">
          <section class="card" aria-labelledby="ab-h"><h2 id="ab-h">能力値</h2>
            ${radar(STATS.map((s) => r[s.key]), STATS.map((s) => s.label))}
            <dl style="display:grid;grid-template-columns:auto 1fr auto;gap:4px 12px;font-size:.88rem;margin:8px 0 0">
              ${STATS.map((s) => `<dt>${s.label}</dt><dd class="muted" style="margin:0">${s.help}</dd><dd style="margin:0;text-align:right" class="tnum"><b>${r[s.key]}</b></dd>`).join('')}
            </dl>
          </section>
          <section class="card" aria-labelledby="rec-h"><h2 id="rec-h">成績の目安</h2>
            <table class="table"><tbody>
              <tr><th>勝率</th><td class="tnum"><b>${r.winRate.toFixed(2)}</b></td></tr>
              <tr><th>2連対率</th><td class="tnum"><b>${r.quinellaRate}%</b></td></tr>
              <tr><th>平均スタートタイミング</th><td class="tnum"><b>${stText(r.avgST)}</b></td></tr>
              ${motor ? `<tr><th>この開催のモーター</th><td class="tnum">${motor.no}号機（2連対率 ${motor.rate.toFixed(1)}%）</td></tr>` : ''}
            </tbody></table>
            <p style="margin-top:12px">${esc(r.note)}</p>
            <p class="muted" style="font-size:.82rem">勝率・2連対率は能力値から算出した架空の数値です。体重が軽いほど直線で有利ですが、波の影響は受けやすくなります。</p>
          </section>
        </div>
        <section class="card" style="margin-top:12px" aria-labelledby="ent-h"><h2 id="ent-h">この開催の出走</h2>
          ${
            entries.length
              ? `<ul class="race-list">${entries
                  .map(({ c, e }) => {
                    const rt = m.runtime[c.id];
                    let fin = '';
                    if (raceStatus(rt, now) === 'finished' && rt.order) {
                      fin = rt.settlement?.excluded.includes(e!.number) ? '返還欠場' : `${rt.order.indexOf(e!.number) + 1}着`;
                    }
                    return `<li class="race-item"><a href="#/race/${encodeURIComponent(c.id)}">
                      <span class="race-no">${c.no}R</span>
                      <span><b>${raceTitle(c)}</b><br><span class="race-meta">${surfaceChip(c)} ${conditionText(c)}・${numBadge(e!.number)} 号艇</span></span>
                      <span><b>${fin}</b></span></a></li>`;
                  })
                  .join('')}</ul>`
              : '<p class="muted">この開催には出走していません。</p>'
          }
        </section>`;
      el.querySelector('[data-back]')?.addEventListener('click', () => history.back());
    },
  };
}
