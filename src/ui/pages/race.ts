/**
 * レース詳細・観戦画面：映像、出走表、オッズ、投票、実況、結果を1画面で扱う。
 * スマートフォンでは映像の下をタブで切り替え、PC では右側に投票パネルを常時表示する。
 */
import { BET_TYPES, BET_TYPE_BY_ID, type BetTypeId, parseKey } from '../../core/bettypes';
import { type CommentaryLine, buildCommentary } from '../../core/commentary';
import { runRace, verifyRace } from '../../core/meeting';
import { type OddsBook, payout, popularity } from '../../core/pool';
import { closeRace, currentOddsBook, finishRace } from '../../core/raceflow';
import { activeRestriction } from '../../core/responsible';
import { analyzeRace, stText } from '../../core/analysis';
import { DISTANCE, LAP } from '../../core/course';
import { LEAD, type SimResult, formatRaceTime } from '../../core/sim';
import { placeBet, quoteBet } from '../../core/state';
import { createViewer } from '../../render';
import { Viewer2D } from '../../render/viewer2d';
import { Playback, gateFrames } from '../../render/playback';
import { CAMERA_LABEL, type CameraMode, type RaceViewer } from '../../render/types';
import {
  type Page,
  conditionText,
  racerOf,
  raceTitle,
  runtimeOf,
  statusChip,
  statusOf,
  surfaceChip,
  timingText,
} from '../common';
import { store } from '../store';
import { $, coins, countdown, esc, numBadge, openDialog, toast } from '../util';

type Tab = 'card' | 'bet' | 'odds' | 'feed' | 'result';
const TAB_LABEL: Record<Tab, string> = { card: '出走表', bet: '投票', odds: 'オッズ', feed: '実況', result: '結果' };

export function racePage(raceId: string): Page {
  const card = store.state.meeting?.cards.find((c) => c.id === raceId);
  if (!card) {
    return {
      title: 'レースが見つかりません',
      render: (el) =>
        (el.innerHTML = `<h1>レースが見つかりません</h1><p>開催が新しくなった可能性があります。<a href="#/races">レース一覧へ</a></p>`),
    };
  }
  const numbers = card.entries.map((e) => e.number);
  const wideMq = matchMedia('(min-width: 1024px)');

  let el: HTMLElement;
  let tab: Tab = statusOf(card) === 'finished' ? 'result' : 'card';
  let betType: BetTypeId = 'trifecta';
  let selection: number[] = [];
  let stake = 100;
  let viewer: RaceViewer | null = null;
  let playback: Playback | null = null;
  let result: SimResult | null = null;
  let commentary: CommentaryLine[] = [];
  let raf = 0;
  let lastStatus = statusOf(card);
  let lastOddsKey = '';
  let camera: CameraMode = 'auto';
  let followIndex = 0;
  let lastOverlay = 0;
  let lastLive = 0;
  let lastFeedCount = -1;
  let verifyHtml = '';
  const resizeObs = new ResizeObserver(() => viewer?.resize());

  const isWide = () => wideMq.matches;
  const tabs = (): Tab[] => (isWide() ? ['card', 'odds', 'feed', 'result'] : ['card', 'bet', 'odds', 'feed', 'result']);

  // ---- データ ----
  const probs = () => store.getProbs(card.id);
  const book = (): OddsBook | null => {
    const p = probs();
    return p ? currentOddsBook(store.state, card, p, store.now()) : null;
  };
  const ensureResult = (): SimResult | null => {
    // 結果は締切後にだけ計算する（発売中に画面から結果が分からないように）
    if (result || statusOf(card) === 'open') return result;
    result = runRace(card, card.seed);
    playback = new Playback(card, result);
    playback.speed = store.prefs.speed;
    commentary = buildCommentary(card, result);
    viewer?.setRace(card, result);
    return result;
  };
  const restriction = (): string | null => {
    const s = store.state;
    const now = store.now();
    const r = activeRestriction(s, now);
    if (r) return r.code === 'self_excluded' ? '自己排除の期間中のため、投票できません。' : '休止期間中のため、投票できません。';
    return null;
  };

  // ---- 部分テンプレート ----
  const oddsText = (b: OddsBook | null, type: BetTypeId, key: string): string => {
    if (!b) return '—';
    const ranges = b.ranges[type];
    if (ranges) {
      const r = ranges[key];
      return r ? `${r[0].toFixed(1)}–${r[1].toFixed(1)}` : '—';
    }
    const o = b.odds[type][key];
    return o === null || o === undefined ? '—' : o.toFixed(1);
  };

  const oddsStateHtml = () => {
    const st = statusOf(card);
    if (st === 'open') return `<span class="odds-state"><i class="dot live" aria-hidden="true"></i>変動中（10秒ごとに更新）</span>`;
    return `<span class="odds-state"><i class="dot" aria-hidden="true"></i>確定（締切時点）</span>`;
  };

  const cardTab = () => {
    const b = book();
    const pop = b ? popularity(b, 'win') : [];
    const rt = runtimeOf(card);
    const fin = rt.order;
    const out = rt.settlement?.excluded ?? [];
    return `
      <div class="table-wrap"><table class="table">
        <caption class="sr-only">${raceTitle(card)} 出走表</caption>
        <thead><tr><th>艇</th><th>選手</th><th class="r">勝率<br>2連率</th><th class="r">平均ST</th><th class="r hide-sm">モーター<br>2連率</th><th class="r hide-sm">ボート<br>2連率</th><th class="r">展示</th><th class="r">単勝</th><th class="r hide-sm">人気</th>${fin ? '<th class="r">着</th>' : ''}</tr></thead>
        <tbody>${card.entries
          .map((e) => {
            const r = racerOf(e);
            const key = String(e.number);
            const rank = out.includes(e.number) ? '返還' : fin ? String(fin.indexOf(e.number) + 1) : '';
            return `<tr class="${selection.includes(e.number) ? 'is-selected' : ''}">
              <td>${numBadge(e.number, 'lg')}</td>
              <td class="entry-name"><a href="#/racer/${r.id}">${esc(r.name)}</a><div class="entry-sub"><span class="grade grade-${r.grade}">${r.grade}</span> ${esc(r.branch)}・${r.age}歳・${r.weight.toFixed(1)}kg</div></td>
              <td class="r tnum">${r.winRate.toFixed(2)}<div class="entry-sub">${r.quinellaRate}%</div></td>
              <td class="r tnum">${stText(r.avgST)}</td>
              <td class="r tnum hide-sm">${e.motor.no}<div class="entry-sub">${e.motor.rate.toFixed(1)}%</div></td>
              <td class="r tnum hide-sm">${e.boatNo}<div class="entry-sub">${e.boatRate.toFixed(1)}%</div></td>
              <td class="r tnum">${e.exhibition.toFixed(2)}</td>
              <td class="r tnum" data-odds="win:${key}">${oddsText(b, 'win', key)}</td>
              <td class="r tnum hide-sm" data-pop="${key}">${pop.indexOf(key) >= 0 ? pop.indexOf(key) + 1 : '—'}</td>
              ${fin ? `<td class="r"><b>${rank}</b></td>` : ''}
            </tr>`;
          })
          .join('')}</tbody>
      </table></div>
      <p class="muted" style="font-size:.82rem">進入は枠なり（艇番＝コース）。展示はスタート展示・周回展示のタイム（150m、小さいほど速い）。
      選手名を選ぶと能力の詳細が見られます。級別はA1（上位）〜B2。</p>`;
  };

  const oddsTab = () => {
    const b = book();
    if (!b) return `<p class="loading">オッズを集計しています…</p>`;
    const top = (t: BetTypeId) =>
      popularity(b, t)
        .slice(0, 12)
        .map((k) => {
          const parts = parseKey(k);
          const sep = BET_TYPE_BY_ID[t].ordered ? '-' : '=';
          return `<li><span>${parts.map((n) => numBadge(n)).join(sep)}</span> <b class="tnum">${oddsText(b, t, k)}</b></li>`;
        })
        .join('');
    return `
      <p>${oddsStateHtml()}</p>
      <div class="table-wrap"><table class="table">
        <caption class="sr-only">単勝・複勝オッズ</caption>
        <thead><tr><th>艇</th><th>選手</th><th class="r">単勝</th><th class="r">複勝（幅）</th></tr></thead>
        <tbody>${card.entries
          .map((e) => {
            const k = String(e.number);
            return `<tr><td>${numBadge(e.number)}</td><td>${esc(racerOf(e).name)}</td>
              <td class="r tnum" data-odds="win:${k}">${oddsText(b, 'win', k)}</td>
              <td class="r tnum" data-odds="place:${k}">${oddsText(b, 'place', k)}</td></tr>`;
          })
          .join('')}</tbody></table></div>
      <div class="grid grid-2" style="margin-top:12px">
        <div><h3>3連単 人気上位</h3><ol class="feed" style="max-height:none">${top('trifecta')}</ol></div>
        <div><h3>2連単 人気上位</h3><ol class="feed" style="max-height:none">${top('exacta')}</ol></div>
        <div><h3>3連複 人気上位</h3><ol class="feed" style="max-height:none">${top('trio')}</ol></div>
        <div><h3>2連複 人気上位</h3><ol class="feed" style="max-height:none">${top('quinella')}</ol></div>
      </div>
      <p class="muted" style="font-size:.82rem">票数（デモ）: ${BET_TYPES.map((t) => `${t.label} ${coins(b.totals[t.id])}`).join('／')}。
      オッズ＝票数の合計×(1−控除率)÷その組み合わせの票数。<a href="#/guide">仕組みを詳しく</a></p>`;
  };

  const myTickets = () => {
    const mine = store.state.tickets.filter((t) => t.raceId === card.id);
    if (!mine.length) return '<p class="muted" style="font-size:.85rem">このレースの購入はまだありません。</p>';
    return `<ul class="feed" style="max-height:none">${mine
      .map((t) => {
        const type = BET_TYPE_BY_ID[t.betType];
        const status =
          t.status === 'open'
            ? '<span class="chip chip-open">発売・未確定</span>'
            : t.status === 'won'
              ? `<span class="chip chip-open">的中 ${coins(t.payout!)}（${t.finalOdds!.toFixed(1)}倍）</span>`
              : t.status === 'refunded'
                ? '<span class="chip chip-finished">返還</span>'
                : '<span class="chip chip-finished">不的中</span>';
        return `<li><time>${type.label}</time><span>${t.selection.join(type.ordered ? '-' : '=')}・${coins(t.stake)}コイン ${status}</span></li>`;
      })
      .join('')}</ul>`;
  };

  const betPanel = () => {
    const st = statusOf(card);
    const type = BET_TYPE_BY_ID[betType];
    const b = book();
    const restricted = restriction();
    const head = `<h2>投票（デモコイン）</h2>`;
    if (st !== 'open') {
      return `${head}<p class="notice notice-info">このレースの発売は締め切られました。</p><h3 style="margin-top:12px">購入した券</h3>${myTickets()}`;
    }
    if (restricted) {
      return `${head}<p class="notice">${restricted}</p><p><a href="#/account">設定を確認</a></p><h3>購入した券</h3>${myTickets()}`;
    }
    const picks = card.entries
      .map((e) => {
        const idx = selection.indexOf(e.number);
        const orderBadge = type.ordered && idx >= 0 ? `<span class="pick-order">${idx + 1}着</span>` : '';
        const oddsKey = type.picks === 1 ? String(e.number) : '';
        return `<button type="button" class="pick" data-pick="${e.number}" aria-pressed="${idx >= 0}">
          ${numBadge(e.number)}<span class="nm">${esc(racerOf(e).name)}</span>${orderBadge}
          <span class="odds" ${oddsKey ? `data-odds="${betType}:${oddsKey}"` : ''}>${oddsKey ? oddsText(b, betType, oddsKey) : ''}</span>
        </button>`;
      })
      .join('');
    return `${head}
      <div class="seg" role="group" aria-label="券種">${BET_TYPES.map(
        (t) => `<button type="button" data-type="${t.id}" aria-pressed="${t.id === betType}">${t.label}</button>`,
      ).join('')}</div>
      <p class="muted" style="font-size:.85rem;margin:8px 0">${type.description}${type.ordered ? `（${type.picks === 3 ? '1着→2着→3着' : '1着→2着'}の順に選択）` : ''}</p>
      <div class="picker" role="group" aria-label="艇を選択">${picks}</div>
      <div class="betbar">
        <label class="field" style="margin-bottom:8px"><span>賭け金（100コイン単位）</span>
          <input type="number" inputmode="numeric" min="100" step="100" value="${stake}" data-stake aria-describedby="quote-msg"></label>
        <div class="btn-row" style="margin-bottom:8px">
          ${[100, 500, 1000].map((v) => `<button type="button" class="btn btn-sm" data-add="${v}">+${v}</button>`).join('')}
          <button type="button" class="btn btn-sm" data-add="0">リセット</button>
        </div>
        <div data-quote></div>
        <button type="button" class="btn btn-primary btn-block" data-confirm>購入内容を確認</button>
      </div>
      <h3 style="margin-top:16px">購入した券</h3>${myTickets()}`;
  };

  const quoteHtml = () => {
    const b = book();
    if (!b) return '<p class="muted" id="quote-msg">オッズを集計しています…</p>';
    const type = BET_TYPE_BY_ID[betType];
    if (selection.length < type.picks) {
      return `<p class="muted" id="quote-msg">あと${type.picks - selection.length}艇を選んでください。</p>`;
    }
    const q = quoteBet(store.state, { raceId: card.id, betType, selection, stake }, numbers, b, store.now(), true);
    const est = q.estPayout ? (q.estPayout[0] === q.estPayout[1] ? coins(q.estPayout[0]) : `${coins(q.estPayout[0])}〜${coins(q.estPayout[1])}`) : '—';
    const msg = q.selectionError ?? (q.check.ok ? '' : q.check.message);
    return `<dl class="quote">
        <dt>${type.label}</dt><dd>${selection.join(type.ordered ? '-' : '=')}</dd>
        <dt>現在のオッズ</dt><dd>${oddsText(b, betType, q.key)}倍</dd>
        <dt>想定払戻</dt><dd>${est}</dd>
        <dt>購入後の残高</dt><dd>${coins(q.balanceAfter)}</dd>
      </dl>
      <p id="quote-msg" class="${msg ? 'neg' : 'muted'}" style="font-size:.85rem;margin:0 0 8px">${esc(msg || 'オッズは締切まで変動します。払戻は確定オッズで計算されます。')}</p>`;
  };

  const feedTab = () => {
    if (statusOf(card) === 'open') return '<p class="muted">発走後に実況が表示されます。</p>';
    ensureResult();
    const t = currentTime();
    const lines = commentary.filter((l) => l.t <= t);
    if (!lines.length) return '<p class="muted">まもなく発走です。</p>';
    return `<ol class="feed" aria-label="実況">${[...lines]
      .reverse()
      .map((l) => `<li><time>${raceClock(l.t)}</time><span>${esc(l.text)}</span></li>`)
      .join('')}</ol>`;
  };

  const resultTab = () => {
    const rt = runtimeOf(card);
    if (!rt.order || !rt.settlement) return '<p class="muted">レース確定後に結果が表示されます。</p>';
    const res = ensureResult()!;
    const settle = rt.settlement;
    // 締切後は確定プールから計算されるため、確定オッズ・確定人気になる
    const winOdds = rt.finalPools ? currentOddsBook(store.state, card, probs() ?? store.probsSync(card), store.now()) : null;
    const finalPop = winOdds ? popularity(winOdds, 'win') : [];
    const row = (i: number, rank: string) => {
      const e = card.entries[i];
      const r = racerOf(e);
      const f = res.flags[i];
      return `<tr><td><b>${rank}</b></td><td>${numBadge(e.number)}</td>
          <td class="entry-name"><a href="#/racer/${r.id}">${esc(r.name)}</a><div class="entry-sub">${r.grade}・${esc(r.branch)}</div></td>
          <td class="tnum ${f === 'F' ? 'neg' : ''}">${f === 'L' ? 'L' : stText(res.st[i])}</td>
          <td class="tnum">${f ? '返還欠場' : rank === '1' ? formatRaceTime(res.raceTimes[i]) : res.margins[i]}</td>
          <td class="r tnum">${winOdds && !f ? oddsText(winOdds, 'win', String(e.number)) : '—'}</td>
          <td class="r hide-sm">${f ? '—' : finalPop.indexOf(String(e.number)) + 1 || '—'}</td></tr>`;
    };
    const rows = res.order.map((i, rank) => row(i, String(rank + 1))).join('') + res.excluded.map((i) => row(i, res.flags[i]!)).join('');
    const payouts = BET_TYPES.flatMap((t) => {
      if (settle.voidTypes.includes(t.id)) return [`<tr><td>${t.label}</td><td colspan="3">不成立（全額返還）</td></tr>`];
      return Object.entries(settle.odds[t.id]).map(
        ([k, o]) =>
          `<tr><td>${t.label}</td><td>${k}</td><td class="r tnum">${coins(payout(100, o))}</td><td class="r tnum">${o.toFixed(1)}倍</td></tr>`,
      );
    }).join('');
    const mine = store.state.tickets.filter((t) => t.raceId === card.id);
    const stakeSum = mine.reduce((a, t) => a + t.stake, 0);
    const paySum = mine.reduce((a, t) => a + (t.payout ?? 0), 0);
    const an = analyzeRace(card, res, finalPop[0] ? Number(finalPop[0]) : undefined);
    const factorRows = an.rows
      .map(
        (r) => `<tr><td>${r.rank || r.flag}</td><td>${r.number}</td><td>${esc(r.name)}</td><td class="r tnum">${r.flag === 'L' ? 'L' : stText(r.st)}</td>
          <td class="r tnum">${r.rankAfter1M || '—'}</td><td class="r tnum">${r.flag ? '—' : `${r.drift1M.toFixed(1)}m`}</td>
          <td class="r tnum">${r.flag ? '—' : `${r.wakeTime.toFixed(1)}秒`}</td><td class="r tnum">${r.motorRate.toFixed(1)}%</td><td>${r.notes.join('・') || '—'}</td></tr>`,
      )
      .join('');
    const turnText = res.turnOrders
      .slice(0, 6)
      .map((o) => `${Math.floor(o.turn / 2) + 1}周${(o.turn % 2) + 1}M ${o.order.map((i) => card.entries[i].number).join('-')}`)
      .join('／');
    return `
      <section class="card" aria-labelledby="review-h" style="margin-bottom:16px;background:var(--surface-2)">
        <h2 id="review-h" style="font-size:1.05rem">レースの振り返り</h2>
        <p><b>${esc(an.headline)}</b></p>
        <ul style="margin:0 0 8px;padding-left:1.2em">${an.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
        ${an.favoriteNote ? `<p style="margin:0">${esc(an.favoriteNote)}</p>` : ''}
        <details style="margin-top:8px"><summary>結果に影響した要素の内訳</summary>
          <div class="table-wrap"><table class="table nowrap" style="margin-top:8px">
            <caption class="sr-only">各艇の要素</caption>
            <thead><tr><th>着</th><th>艇</th><th>選手</th><th class="r">ST</th><th class="r">1周1M</th><th class="r">1Mの流れ</th><th class="r">引き波</th><th class="r">モーター</th><th>主な出来事</th></tr></thead>
            <tbody>${factorRows}</tbody></table></div>
          <p class="muted" style="font-size:.8rem">1Mの流れ＝1マークのターンで外へ膨らんだ量。引き波＝前の艇の真後ろを走り減速した時間。
          能力・モーター・水面条件に加え、スタートとターンの小さなゆらぎも結果に影響します。</p>
        </details>
      </section>
      <h2>確定 — 決まり手「${res.kimarite}」</h2>
      ${settle.excluded.length ? `<p class="notice">${settle.excluded.map((n) => `${n}号艇`).join('・')}は返還欠場です。この艇を含む舟券は全額返還されます。</p>` : ''}
      <div class="table-wrap"><table class="table">
        <caption class="sr-only">着順</caption>
        <thead><tr><th>着</th><th>艇</th><th>選手</th><th>ST</th><th>タイム・差</th><th class="r">単勝</th><th class="r hide-sm">人気</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <p class="muted" style="font-size:.85rem">ターンマーク通過順：${turnText}</p>
      <h3>払戻（100コインあたり）</h3>
      <div class="table-wrap"><table class="table"><thead><tr><th>券種</th><th>組番</th><th class="r">払戻</th><th class="r">オッズ</th></tr></thead><tbody>${payouts}</tbody></table></div>
      ${
        mine.length
          ? `<h3 style="margin-top:12px">あなたの結果</h3>
             <p>投票 ${coins(stakeSum)}・払戻（返還を含む） ${coins(paySum)}・収支 <b class="${paySum - stakeSum >= 0 ? 'pos' : 'neg'}">${paySum - stakeSum >= 0 ? '+' : '−'}${coins(Math.abs(paySum - stakeSum))}</b></p>${myTickets()}`
          : ''
      }
      <h3 style="margin-top:12px">公正性の検証</h3>
      <p style="font-size:.85rem;word-break:break-all">発売前に公開したハッシュ: <code>${card.commit}</code><br>公開された seed: <code>${card.seed}</code></p>
      <button class="btn btn-sm" data-verify>この seed で結果を再計算する</button>
      <div data-verify-out aria-live="polite">${verifyHtml}</div>`;
  };

  /** 映像の時刻をレースの時計（スタート合図からの秒）で表示する */
  const raceClock = (t: number): string => {
    const r = t - LEAD;
    if (r < 0) return `-${Math.ceil(-r)}秒`;
    return `${Math.floor(r / 60)}:${String(Math.floor(r % 60)).padStart(2, '0')}`;
  };

  // ---- 映像 ----
  const currentTime = (): number => {
    const rt = runtimeOf(card);
    const st = statusOf(card);
    if (st === 'running' && rt.startsAt) return Math.max(0, (store.now() - rt.startsAt) / 1000);
    if (st === 'finished' && playback) return playback.time;
    return 0;
  };

  const stageHtml = () => `
    <div class="stage" data-stage>
      <div class="ov ov-tl"><div class="ov-box"><b>${card.no}R</b> ${esc(card.name)}<span class="ov-sub">${card.conditions.distance}m・3周</span></div></div>
      <div class="ov ov-tr"><div class="ov-box" data-ov-tr></div></div>
      <div class="ov ov-lower" data-ov-lower aria-hidden="true"></div>
      <div class="ov ov-bottom"><div class="ticker" data-ticker aria-hidden="true"></div><div class="progress"><i data-progress></i></div></div>
    </div>
    <div class="stage-controls" data-controls></div>
    <div class="sr-only" aria-live="polite" data-live></div>`;

  const controlsHtml = () => {
    const st = statusOf(card);
    const cams = (Object.keys(CAMERA_LABEL) as CameraMode[])
      .map((c) => `<button type="button" data-cam="${c}" aria-pressed="${c === camera}">${CAMERA_LABEL[c]}</button>`)
      .join('');
    const follow = `<label class="sr-only" for="follow-sel">注目艇</label><select id="follow-sel" data-follow style="width:auto;min-height:36px">${card.entries
      .map((e, i) => `<option value="${i}" ${i === followIndex ? 'selected' : ''}>${e.number}号艇 ${esc(racerOf(e).name)}</option>`)
      .join('')}</select>`;
    let extra = '';
    if (st === 'open') extra = `<button class="btn btn-sm" data-close-now>今すぐ締切して発走（デモ）</button>`;
    if (st === 'running') extra = `<span class="chip chip-running">LIVE</span><button class="btn btn-sm" data-skip>結果へスキップ</button>`;
    if (st === 'finished' && playback) {
      extra = `<button class="btn btn-sm" data-play aria-label="${playback.paused ? '再生' : '一時停止'}">${playback.paused ? '▶ 再生' : '❚❚ 停止'}</button>
        <div class="seg" role="group" aria-label="再生速度">${[1, 2, 4].map((v) => `<button type="button" data-speed="${v}" aria-pressed="${playback!.speed === v}">${v}x</button>`).join('')}</div>
        <input type="range" min="0" max="${playback.duration.toFixed(1)}" step="0.1" value="${playback.time.toFixed(1)}" data-seek aria-label="再生位置" style="flex:1;min-width:120px">`;
    }
    const view = store.prefs.viewer;
    const quality = store.prefs.quality;
    const viewSel = `<div class="seg" role="group" aria-label="映像の種類">${(['3d', '2d'] as const)
      .map((v) => `<button type="button" data-view="${v}" aria-pressed="${view === v}">${v === '3d' ? '3D' : '2D'}</button>`)
      .join('')}</div>`;
    const qualitySel =
      viewer?.kind === '3d'
        ? `<label class="sr-only" for="quality-sel">画質</label><select id="quality-sel" data-quality style="width:auto;min-height:36px">${(
            [['auto', '画質: 自動'], ['low', '画質: 低'], ['medium', '画質: 中'], ['high', '画質: 高']] as const
          )
            .map(([q, l]) => `<option value="${q}" ${q === quality ? 'selected' : ''}>${l}</option>`)
            .join('')}</select>`
        : '';
    const note = view === '3d' && viewer?.kind === '2d' ? '<span class="muted" style="font-size:.8rem">3D非対応のため2D表示</span>' : '';
    return `<div class="seg" role="group" aria-label="カメラ">${cams}</div>${follow}${extra}
      <span style="display:flex;gap:8px;align-items:center;margin-left:auto">${note}${viewSel}${qualitySel}</span>`;
  };

  let mountToken = 0;
  /** 映像を（再）作成する。3D に失敗したら 2D 上空図に切り替える */
  const mountViewer = async (force2d = false) => {
    const stage = el.querySelector<HTMLElement>('[data-stage]');
    if (!stage) return;
    const token = ++mountToken;
    viewer?.dispose();
    viewer = null;
    const prefs = force2d ? { ...store.prefs, viewer: '2d' as const } : store.prefs;
    let v = await createViewer(prefs, {
      onFail: () => {
        toast('3D表示を続けられないため、2D上空図に切り替えました。', 'warn');
        void mountViewer(true);
      },
    });
    if (token !== mountToken || !el.isConnected) return v.dispose();
    try {
      v.mount(stage);
    } catch (e) {
      console.warn(e);
      v.dispose();
      v = new Viewer2D();
      v.mount(stage);
      toast('3D表示を開始できなかったため、2D上空図で表示しています。', 'warn');
    }
    viewer = v;
    viewer.setRace(card, ensureResult());
    viewer.setCamera?.(camera, followIndex);
    resizeObs.disconnect();
    resizeObs.observe(stage);
    $(el, '[data-controls]').innerHTML = controlsHtml();
  };

  const frame = (wall: number) => {
    raf = requestAnimationFrame(frame);
    if (!viewer) return;
    const st = statusOf(card);
    let t = 0;
    let boats = gateFrames(card);
    if (playback && st !== 'open') {
      t = st === 'finished' ? playback.replayClock(wall) : currentTime();
      t = Math.min(t, playback.duration);
      boats = playback.at(t);
    }
    viewer.render(t, boats);

    if (wall - lastOverlay < 200) return;
    lastOverlay = wall;
    updateOverlay(st, t, boats);
  };

  const updateOverlay = (st: ReturnType<typeof statusOf>, t: number, boats: ReturnType<typeof gateFrames>) => {
    const tr = el.querySelector('[data-ov-tr]');
    const lower = el.querySelector('[data-ov-lower]');
    const ticker = el.querySelector('[data-ticker]');
    const prog = el.querySelector<HTMLElement>('[data-progress]');
    if (!tr || !lower || !ticker || !prog) return;
    const rt = runtimeOf(card);
    if (st === 'open') {
      tr.innerHTML = `締切まで <b>${countdown(rt.closesAt - store.now())}</b>`;
      lower.innerHTML = '';
      ticker.innerHTML = `<span class="ov-box">発売中 — 締切後に待機行動に入ります</span>`;
    } else if (st === 'closed') {
      tr.innerHTML = rt.startsAt ? `発走まで <b>${countdown(rt.startsAt - store.now())}</b>` : '締切';
      lower.innerHTML = '';
      ticker.innerHTML = `<span class="ov-box">待機行動中…まもなくスタート</span>`;
    } else if (playback) {
      const rem = playback.leaderRemaining(boats);
      const leadX = DISTANCE - rem;
      const lap = Math.min(3, Math.floor(Math.max(0, leadX) / LAP) + 1);
      const lapText = t < LEAD ? 'スタート前' : rem <= 0 ? '<b>ゴール</b>' : lap === 3 ? '<b>最終周回</b>' : `<b>${lap}周目</b>`;
      tr.innerHTML = `${lapText}<span class="ov-sub tnum">${raceClock(t)}</span>`;
      // 中継のロワーサード：最終周回は上位3艇、確定後は着順（映像の中央は空ける）
      const final = st === 'finished' && playback.time >= playback.duration - 0.05;
      const ltRow = (i: number, r: number) =>
        `<span class="lt-row"><span class="lt-rank">${r + 1}</span>${numBadge(card.entries[i].number)}<span class="lt-name">${esc(racerOf(card.entries[i]).name)}</span></span>`;
      if (final) {
        lower.innerHTML = `<div class="lower-third"><span class="lt-title">確定</span>${result!.order.slice(0, 3).map(ltRow).join('')}</div>`;
      } else if (lap === 3 && rem > 0) {
        const top = [...boats].sort((a, b) => a.rank - b.rank).slice(0, 3);
        lower.innerHTML = `<div class="lower-third">${top.map((h, r) => ltRow(h.index, r)).join('')}</div>`;
      } else {
        lower.innerHTML = '';
      }
      prog.style.width = `${Math.max(0, Math.min(100, (leadX / DISTANCE) * 100))}%`;
    }
    const ranked = [...boats].sort((a, b) => a.rank - b.rank);
    if (st !== 'open' && st !== 'closed')
      ticker.innerHTML = ranked.map((h) => numBadge(h.number, h.out ? 'is-out' : '')).join('');

    // スクリーンリーダー向けの順位読み上げ（8秒ごと）
    if (st === 'running' && performance.now() - lastLive > 8000) {
      lastLive = performance.now();
      const live = el.querySelector('[data-live]');
      const rem = playback ? Math.ceil(playback.leaderRemaining(boats)) : 0;
      if (live)
        live.textContent = `残り${rem}メートル。${ranked
          .filter((h) => !h.out)
          .slice(0, 3)
          .map((h, i) => `${i + 1}番手 ${h.number}号艇 ${racerOf(card.entries[h.index]).name}`)
          .join('、')}`;
    }
    // 実況タブは新しい行があるときだけ更新
    if (tab === 'feed' && st !== 'open') {
      const count = commentary.filter((l) => l.t <= t).length;
      if (count !== lastFeedCount) {
        lastFeedCount = count;
        const panel = el.querySelector('[data-panel]');
        if (panel) panel.innerHTML = feedTab();
      }
    }
  };

  // ---- 描画 ----
  const tabPanelHtml = () => {
    switch (tab) {
      case 'card':
        return cardTab();
      case 'bet':
        return betPanel();
      case 'odds':
        return oddsTab();
      case 'feed':
        return feedTab();
      case 'result':
        return resultTab();
    }
  };

  const renderPanels = () => {
    if (!tabs().includes(tab)) tab = 'card';
    $(el, '[data-tabs]').innerHTML = tabs()
      .map(
        (t) =>
          `<button role="tab" id="tab-${t}" aria-controls="panel" aria-selected="${t === tab}" tabindex="${t === tab ? 0 : -1}" data-tab="${t}">${TAB_LABEL[t]}</button>`,
      )
      .join('');
    $(el, '[data-panel]').innerHTML = tabPanelHtml();
    $(el, '[data-panel]').setAttribute('aria-labelledby', `tab-${tab}`);
    const side = el.querySelector<HTMLElement>('[data-side]');
    if (side) {
      side.hidden = !isWide();
      side.innerHTML = isWide() ? `<div class="card">${betPanel()}</div>` : '';
    }
    refreshQuote();
    $(el, '[data-controls]').innerHTML = controlsHtml();
    $(el, '[data-head-status]').innerHTML = `${statusChip(statusOf(card))} <span data-timing>${timingText(card)}</span>`;
    lastFeedCount = -1;
  };

  const refreshQuote = () => {
    el.querySelectorAll('[data-quote]').forEach((q) => (q.innerHTML = quoteHtml()));
  };

  const refreshOdds = () => {
    const b = book();
    el.querySelectorAll<HTMLElement>('[data-odds]').forEach((n) => {
      const [type, key] = n.dataset.odds!.split(':');
      n.textContent = oddsText(b, type as BetTypeId, key);
    });
    if (b) {
      const pop = popularity(b, 'win');
      el.querySelectorAll<HTMLElement>('[data-pop]').forEach((n) => {
        const i = pop.indexOf(n.dataset.pop!);
        n.textContent = i >= 0 ? String(i + 1) : '—';
      });
    }
    refreshQuote();
  };

  const draw = () => {
    el.innerHTML = `
      <nav aria-label="パンくず" class="muted" style="font-size:.85rem;margin-bottom:4px"><a href="#/races">レース一覧</a> › ${card.no}R</nav>
      <div class="race-head"><h1>${raceTitle(card)}</h1><span data-head-status></span></div>
      <p class="race-meta" style="margin-bottom:12px">${surfaceChip(card)} ${conditionText(card)}</p>
      <div class="race-layout">
        <div>
          ${stageHtml()}
          <div class="tabs" role="tablist" aria-label="レース情報" data-tabs></div>
          <div id="panel" role="tabpanel" data-panel></div>
        </div>
        <aside class="race-side" data-side aria-label="投票"></aside>
      </div>`;
    renderPanels();
    void mountViewer();
  };

  // ---- 操作 ----
  const confirmPurchase = () => {
    const b = book();
    if (!b) return;
    const type = BET_TYPE_BY_ID[betType];
    const req = { raceId: card.id, betType, selection: [...selection], stake };
    const q = quoteBet(store.state, req, numbers, b, store.now(), statusOf(card) === 'open');
    if (q.selectionError || !q.check.ok) {
      toast(q.selectionError ?? (q.check.ok ? '' : q.check.message), 'warn');
      return;
    }
    const names = selection.map((n) => `${n}号艇 ${racerOf(card.entries.find((e) => e.number === n)!).name}`).join(type.ordered ? ' → ' : '、');
    const est = q.estPayout![0] === q.estPayout![1] ? coins(q.estPayout![0]) : `${coins(q.estPayout![0])}〜${coins(q.estPayout![1])}`;
    const dlg = openDialog(
      `<div class="dialog-body">
        <h2>購入内容の確認</h2>
        <dl>
          <dt>レース</dt><dd>${raceTitle(card)}</dd>
          <dt>券種</dt><dd>${type.label}</dd>
          <dt>選択</dt><dd>${esc(names)}</dd>
          <dt>賭け金</dt><dd>${coins(stake)} コイン</dd>
          <dt>現在のオッズ</dt><dd>${oddsText(b, betType, q.key)}倍（変動中）</dd>
          <dt>想定払戻</dt><dd>${est} コイン</dd>
          <dt>購入後の残高</dt><dd>${coins(q.balanceAfter)} コイン</dd>
        </dl>
        <p class="muted" style="font-size:.85rem">オッズは締切まで変動し、払戻は締切時点の確定オッズで計算されます。
        フライング・出遅れの艇を含む券は返還されます。購入後の取り消しはできません。デモコインに金銭的な価値はありません。</p>
      </div>
      <div class="dialog-actions">
        <button class="btn" data-close>戻る</button>
        <button class="btn btn-primary" data-buy>購入する</button>
      </div>`,
      { label: '購入内容の確認' },
    );
    dlg.querySelector<HTMLButtonElement>('[data-buy]')!.addEventListener('click', async (ev) => {
      (ev.currentTarget as HTMLButtonElement).disabled = true;
      const r = await placeBet(store.state, req, numbers, book()!, store.now(), statusOf(card) === 'open');
      dlg.close();
      if (!r.ok) return toast(r.message, 'warn');
      selection = [];
      store.set(r.state);
      toast(`${type.label} ${req.selection.join(type.ordered ? '-' : '=')} を ${coins(req.stake)}コインで購入しました。`);
    });
  };

  const onClick = async (ev: Event) => {
    const t = ev.target as HTMLElement;
    const tabBtn = t.closest<HTMLElement>('[data-tab]');
    if (tabBtn) {
      tab = tabBtn.dataset.tab as Tab;
      renderPanels();
      el.querySelector<HTMLElement>(`#tab-${tab}`)?.focus();
      return;
    }
    const typeBtn = t.closest<HTMLElement>('[data-type]');
    if (typeBtn) {
      betType = typeBtn.dataset.type as BetTypeId;
      selection = selection.slice(0, BET_TYPE_BY_ID[betType].picks);
      return renderPanels();
    }
    const pick = t.closest<HTMLElement>('[data-pick]');
    if (pick) {
      const n = Number(pick.dataset.pick);
      const type = BET_TYPE_BY_ID[betType];
      if (selection.includes(n)) selection = selection.filter((x) => x !== n);
      else if (type.picks === 1) selection = [n];
      else selection = [...selection, n].slice(-type.picks);
      renderPanels();
      el.querySelector<HTMLElement>(`[data-pick="${n}"]`)?.focus();
      return;
    }
    const add = t.closest<HTMLElement>('[data-add]');
    if (add) {
      const v = Number(add.dataset.add);
      stake = v === 0 ? 100 : stake + v;
      el.querySelectorAll<HTMLInputElement>('[data-stake]').forEach((i) => (i.value = String(stake)));
      return refreshQuote();
    }
    if (t.closest('[data-confirm]')) return confirmPurchase();
    const cam = t.closest<HTMLElement>('[data-cam]');
    if (cam) {
      camera = cam.dataset.cam as CameraMode;
      viewer?.setCamera?.(camera, followIndex);
      $(el, '[data-controls]').innerHTML = controlsHtml();
      return;
    }
    const viewBtn = t.closest<HTMLElement>('[data-view]');
    if (viewBtn) {
      const v = viewBtn.dataset.view as '3d' | '2d';
      if (v !== store.prefs.viewer) {
        store.setPrefs({ viewer: v });
        void mountViewer();
      }
      return;
    }
    if (t.closest('[data-close-now]')) {
      store.set(await closeRace(store.state, card.id, store.probsSync(card), store.now()));
      return;
    }
    if (t.closest('[data-skip]')) {
      store.set(await finishRace(store.state, card.id, store.now()));
      return;
    }
    if (t.closest('[data-play]') && playback) {
      if (playback.time >= playback.duration - 0.05) playback.seek(0);
      playback.paused = !playback.paused;
      $(el, '[data-controls]').innerHTML = controlsHtml();
      return;
    }
    const sp = t.closest<HTMLElement>('[data-speed]');
    if (sp && playback) {
      playback.speed = Number(sp.dataset.speed);
      store.setPrefs({ speed: playback.speed });
      return;
    }
    if (t.closest('[data-verify]')) {
      const v = await verifyRace(card, card.seed);
      const rt = runtimeOf(card);
      const same = v.order.join('-') === rt.order!.join('-') && v.excluded.join(',') === (rt.settlement?.excluded ?? []).join(',');
      verifyHtml = `<p class="${v.hashOk && same ? 'pos' : 'neg'}" style="font-size:.9rem">
        ハッシュ ${v.hashOk ? '一致 ✓' : '不一致 ✗'}／再計算した着順 ${v.order.join('-')}${v.excluded.length ? `（欠場 ${v.excluded.join('・')}）` : ''}（公式結果と${same ? '一致 ✓' : '不一致 ✗'}）</p>`;
      el.querySelector('[data-verify-out]')!.innerHTML = verifyHtml;
    }
  };

  const onInput = (ev: Event) => {
    const t = ev.target as HTMLInputElement;
    if (t.matches('[data-stake]')) {
      stake = Math.max(0, Math.floor(Number(t.value) || 0));
      refreshQuote();
    } else if (t.matches('[data-seek]') && playback) {
      playback.seek(Number(t.value));
    }
  };

  const onChange = (ev: Event) => {
    const t = ev.target as HTMLSelectElement;
    if (t.matches('[data-quality]')) {
      const q = t.value as 'auto' | 'low' | 'medium' | 'high';
      store.setPrefs({ quality: q });
      viewer?.setQuality?.(q);
      return;
    }
    if (t.matches('[data-follow]')) {
      followIndex = Number(t.value);
      if (camera !== 'follow') camera = 'follow';
      viewer?.setCamera?.(camera, followIndex);
      $(el, '[data-controls]').innerHTML = controlsHtml();
    }
  };

  const onKey = (ev: KeyboardEvent) => {
    // タブのキーボード操作（左右キーで移動）
    const t = ev.target as HTMLElement;
    if (!t.matches('[role="tab"]') || !['ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
    const list = tabs();
    const i = list.indexOf(tab);
    tab = list[(i + (ev.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
    renderPanels();
    el.querySelector<HTMLElement>(`#tab-${tab}`)?.focus();
    ev.preventDefault();
  };

  const onMq = () => renderPanels();

  return {
    title: `${card.no}R ${card.name}`,
    render(root) {
      el = root;
      void store.requestProbs(card);
      draw();
      el.addEventListener('click', onClick);
      el.addEventListener('input', onInput);
      el.addEventListener('change', onChange);
      el.addEventListener('keydown', onKey);
      wideMq.addEventListener('change', onMq);
      if (statusOf(card) === 'finished') {
        ensureResult();
        playback!.seek(playback!.duration);
        playback!.paused = true;
        $(el, '[data-controls]').innerHTML = controlsHtml();
      }
      raf = requestAnimationFrame(frame);
    },
    update(reason) {
      const st = statusOf(card);
      if (st !== lastStatus) {
        // 発走・確定などの状態遷移
        if (st !== 'open') ensureResult();
        if (st === 'finished' && playback) {
          playback.seek(playback.duration);
          playback.paused = true;
          tab = 'result';
        }
        if (st === 'running' && tab === 'card') tab = 'feed';
        lastStatus = st;
        return renderPanels();
      }
      if (reason === 'state' || reason === 'probs') return renderPanels();
      // tick: 時刻表示とオッズ（10秒ごと）
      const timing = el.querySelector('[data-timing]');
      if (timing) timing.innerHTML = timingText(card);
      const rt = runtimeOf(card);
      const key = `${Math.floor((Math.min(store.now(), rt.closesAt) - rt.openedAt) / 10000)}:${rt.closedAt ?? ''}`;
      if (key !== lastOddsKey) {
        lastOddsKey = key;
        refreshOdds();
      }
      if (st === 'finished' && playback && !playback.paused) {
        const seek = el.querySelector<HTMLInputElement>('[data-seek]');
        if (seek && document.activeElement !== seek) seek.value = playback.time.toFixed(1);
      }
    },
    dispose() {
      mountToken++;
      cancelAnimationFrame(raf);
      resizeObs.disconnect();
      viewer?.dispose();
      wideMq.removeEventListener('change', onMq);
    },
  };
}

