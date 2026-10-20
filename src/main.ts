import './ui/styles.css';
import { BET_LIMITS_ENABLED, SELF_EXCLUSION_ENABLED, dayStats, effectiveLimits, reminderDue, startBreak } from './core/responsible';
import { type Page, ICONS } from './ui/common';
import { accountPage } from './ui/pages/account';
import { guidePage } from './ui/pages/guide';
import { historyPage } from './ui/pages/history';
import { homePage } from './ui/pages/home';
import { racePage } from './ui/pages/race';
import { racerPage } from './ui/pages/racer';
import { racesPage } from './ui/pages/races';
import { store } from './ui/store';
import { $, coins, esc, openDialog, signClass, signed, toast } from './ui/util';

const NAV = [
  { href: '#/', label: 'トップ', icon: ICONS.home, match: /^$/ },
  { href: '#/races', label: 'レース', icon: ICONS.races, match: /^(races|race\/)/ },
  { href: '#/history', label: '収支', icon: ICONS.history, match: /^history/ },
  { href: '#/guide', label: '遊び方', icon: ICONS.guide, match: /^guide/ },
  { href: '#/account', label: '設定', icon: ICONS.account, match: /^account/ },
];

function shell(): void {
  document.body.innerHTML = `
    <a class="skip-link" href="#main">本文へスキップ</a>
    <header class="site-header">
      <a class="brand" href="#/" aria-label="Virtual Boat トップへ"><span class="brand-mark" aria-hidden="true">🚤</span><span>Virtual Boat</span></a>
      <span class="demo-badge" title="デモコインは換金できません">DEMO</span>
      <nav class="nav-desktop" aria-label="メイン">${NAV.map((n) => `<a href="${n.href}">${n.label}</a>`).join('')}</nav>
      <div class="wallet" id="wallet" aria-live="off"></div>
    </header>
    <main id="main" tabindex="-1"></main>
    <footer class="site-footer">
      <p>これはボートレースのシミュレーションのデモです。デモコインは購入・換金・譲渡ができず、金銭的な価値はありません。
      登場する選手・レース場・レースはすべて架空で、実在の団体・レース場とは関係ありません。<a href="#/guide">遊び方と仕組み</a>／<a href="#/account">設定</a></p>
    </footer>
    <nav class="nav-mobile" aria-label="メイン">${NAV.map((n) => `<a href="${n.href}">${n.icon}<span>${n.label}</span></a>`).join('')}</nav>
    <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>`;
}

function renderWallet(): void {
  const s = store.state;
  const st = dayStats(s, store.now());
  $(document, '#wallet').innerHTML = `
    <b class="tnum">${coins(s.balance)}</b> <small style="display:inline">コイン</small>
    <small>本日 <span class="tnum ${signClass(st.settledNet)}">${signed(st.settledNet)}</span></small>`;
}

// ---- ルーター ----
let current: Page | null = null;

function route(): void {
  const path = location.hash.replace(/^#\/?/, '');
  current?.dispose?.();
  const [head, param] = path.split('/');
  let page: Page;
  switch (head) {
    case '':
      page = homePage();
      break;
    case 'guide':
      page = guidePage();
      break;
    case 'races':
      page = racesPage();
      break;
    case 'race':
      page = racePage(decodeURIComponent(param ?? ''));
      break;
    case 'racer':
      page = racerPage(decodeURIComponent(param ?? ''));
      break;
    case 'history':
      page = historyPage();
      break;
    case 'account':
      page = accountPage();
      break;
    default:
      page = {
        title: 'ページが見つかりません',
        render: (el) => (el.innerHTML = '<h1>ページが見つかりません</h1><p><a href="#/">トップへ</a></p>'),
      };
  }
  current = page;
  const main = $(document, '#main');
  page.render(main);
  document.title = `${page.title} | Virtual Boat`;
  document.querySelectorAll<HTMLAnchorElement>('.nav-desktop a, .nav-mobile a').forEach((a) => {
    const n = NAV.find((x) => x.href === a.getAttribute('href'));
    if (n?.match.test(path)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
}

// ---- 年齢確認（初回のみ） ----
function ageGate(): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = openDialog(
      `<div class="dialog-body">
        <h2>はじめに</h2>
        <p>Virtual Boat は、架空の選手で遊ぶ<strong>ボートレースのシミュレーションのデモ</strong>です。</p>
        <ul>
          <li>賭けには<strong>デモコイン</strong>だけを使います。購入・換金・譲渡はできず、金銭的な価値はありません。</li>
          <li>登場する選手・レース場・レースはすべて架空です。水面の形は江戸川の公開情報を参考にした非公式の再現です。</li>
          <li>ご利用は<strong>18歳以上</strong>の方に限ります（自己申告）。</li>
        </ul>
        <p class="muted">デモのため年齢は自己申告で確認しています。本番では提供地域の法令に沿った本人確認を行います。</p>
      </div>
      <div class="dialog-actions">
        <button class="btn" data-age="no">18歳未満です</button>
        <button class="btn btn-primary" data-age="yes">18歳以上です。はじめる</button>
      </div>`,
      { label: '年齢確認' },
    );
    dlg.addEventListener('cancel', (ev) => ev.preventDefault()); // Esc で閉じさせない
    dlg.addEventListener('click', (ev) => {
      const v = (ev.target as HTMLElement).closest<HTMLElement>('[data-age]')?.dataset.age;
      if (!v) return;
      dlg.close();
      resolve(v === 'yes');
    });
  });
}

// ---- 利用時間リマインダー・損失通知 ----
let lossNotifiedDay = '';
function responsibleChecks(): void {
  const now = store.now();
  const s = store.state;
  const lim = effectiveLimits(s, now);
  if (reminderDue(store.sessionStart, store.lastReminder, lim, now) && !document.querySelector('dialog[open]')) {
    store.lastReminder = now;
    const mins = Math.round((now - store.sessionStart) / 60000);
    const st = dayStats(s, now);
    const dlg = openDialog(
      `<div class="dialog-body">
        <h2>利用時間のお知らせ</h2>
        <p>このセッションを始めてから <strong>${mins}分</strong> が経過しました。</p>
        <dl><dt>本日の投票額</dt><dd>${coins(st.staked)}</dd><dt>本日の収支（確定分）</dt><dd class="${signClass(st.settledNet)}">${signed(st.settledNet)}</dd></dl>
        <p class="muted">通知の間隔は「設定」で変更できます。</p>
      </div>
      <div class="dialog-actions">
        ${SELF_EXCLUSION_ENABLED ? '<button class="btn" data-break>24時間休止する</button>' : ''}
        <button class="btn btn-primary" data-close>続ける</button>
      </div>`,
      { label: '利用時間のお知らせ' },
    );
    dlg.querySelector('[data-break]')?.addEventListener('click', () => {
      store.set(startBreak(store.state, 24, store.now()));
      dlg.close();
      toast('24時間の休止を開始しました。観戦はできますが投票はできません。');
    });
  }
  const st = dayStats(s, now);
  const key = new Date(now).toDateString();
  if (BET_LIMITS_ENABLED && lossNotifiedDay !== key && -st.settledNet >= lim.dailyLoss * 0.8) {
    lossNotifiedDay = key;
    toast(`本日の損失が上限（${coins(lim.dailyLoss)}コイン）の80%に達しました。`, 'warn');
  }
}

async function boot(): Promise<void> {
  shell();
  const main = $(document, '#main');
  main.innerHTML = '<p class="loading">読み込み中…</p>';
  await store.init();
  renderWallet();

  if (!store.state.ageConfirmedAt) {
    const ok = await ageGate();
    if (!ok) {
      main.innerHTML = `<div class="card"><h1>ご利用いただけません</h1>
        <p>このサービスは18歳以上の方を対象としています。</p></div>`;
      return;
    }
    store.set({ ...store.state, ageConfirmedAt: store.now() });
  }

  store.subscribe((reason) => {
    renderWallet();
    current?.update?.(reason);
    if (reason !== 'probs') responsibleChecks();
  });
  window.addEventListener('hashchange', route);
  route();
  if (store.engineMigrated) toast('レースの計算方式を更新したため、新しい開催を始めました。未確定だった投票は返還しました。');
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<main style="padding:24px"><h1>読み込みに失敗しました</h1><p>${esc(String(err))}</p></main>`;
});
