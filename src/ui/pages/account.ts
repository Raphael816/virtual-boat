import { appendAudit, verifyAudit } from '../../core/audit';
import {
  BET_LIMITS_ENABLED,
  SELF_EXCLUSION_ENABLED,
  activeRestriction,
  type Limits,
  changeLimits,
  effectiveLimits,
  fmtDate,
  selfExclude,
  startBreak,
} from '../../core/responsible';
import type { Page } from '../common';
import { type Quality, store } from '../store';
import { coins, dateTime, esc, openDialog, toast } from '../util';

const AUDIT_LABEL: Record<string, string> = {
  account_created: 'アカウント作成',
  race_open: '発売開始（ハッシュ公開）',
  bet: '購入',
  race_close: '締切',
  race_result: '確定（seed 公開）',
  settle: '払戻',
  limits_change: '上限変更',
  break: '一時休止',
  self_exclusion: '自己排除',
  refill: '補充',
};

export function accountPage(): Page {
  let el: HTMLElement;
  let auditMsg = '';

  const draw = () => {
    const s = store.state;
    const now = store.now();
    const lim = effectiveLimits(s, now);
    const pending = s.pendingLimits && s.pendingLimits.effectiveAt > now ? s.pendingLimits : null;
    const restriction = activeRestriction(s, now);
    const onBreak = restriction?.code === 'on_break';
    const excluded = restriction?.code === 'self_excluded';
    const p = store.prefs;
    const numField = (key: keyof Limits, label: string, step = 100) =>
      `<label class="field"><span>${label}</span><input type="number" min="0" step="${step}" name="${key}" value="${lim[key]}" inputmode="numeric"></label>`;

    el.innerHTML = `
      <h1>アカウント設定</h1>
      <section class="card" aria-labelledby="prof-h"><h2 id="prof-h">プロフィール</h2>
        <form data-form="profile" class="grid grid-2" style="align-items:end">
          <label class="field" style="margin:0"><span>ニックネーム（端末内のみに保存）</span><input type="text" name="nickname" maxlength="20" value="${esc(s.nickname)}"></label>
          <div><button class="btn">保存</button></div>
        </form>
        <p class="muted" style="font-size:.85rem;margin-top:8px">年齢確認：${s.ageConfirmedAt ? `${dateTime(s.ageConfirmedAt)}に18歳以上と申告済み（デモのため自己申告）` : '未確認'}</p>
      </section>

      <section class="card" aria-labelledby="lim-h"><h2 id="lim-h">利用上限</h2>
        ${
          BET_LIMITS_ENABLED
            ? '<p class="muted" style="font-size:.88rem">引き下げはすぐに反映されます。引き上げは<b>24時間後</b>に反映されます。</p>'
            : '<p class="notice notice-info" style="margin-bottom:12px">現在、投票上限（1レース・1日・損失）はオフです（デモ設定）。残高の範囲で自由に投票できます。</p>'
        }
        ${pending ? `<p class="notice" style="margin-bottom:12px">引き上げの反映待ち：${fmtDate(pending.effectiveAt)} から 1レース ${coins(pending.limits.perRace)}／1日 ${coins(pending.limits.daily)}／損失 ${coins(pending.limits.dailyLoss)}</p>` : ''}
        <form data-form="limits">
          <div class="grid grid-2">
            ${BET_LIMITS_ENABLED ? numField('perRace', '1レースあたりの投票上限（コイン）') : ''}
            ${BET_LIMITS_ENABLED ? numField('daily', '1日あたりの投票上限（コイン）') : ''}
            ${BET_LIMITS_ENABLED ? numField('dailyLoss', '1日の損失上限（コイン）') : ''}
            ${numField('sessionReminderMin', '利用時間のお知らせ（分ごと、0で無効）', 5)}
          </div>
          <button class="btn btn-primary">${BET_LIMITS_ENABLED ? '上限を保存' : '保存'}</button>
        </form>
      </section>

      ${
        SELF_EXCLUSION_ENABLED
          ? `<section class="card" aria-labelledby="brk-h"><h2 id="brk-h">一時休止・自己排除</h2>
        ${onBreak ? `<p class="notice" style="margin-bottom:8px">休止中：${fmtDate(s.breakUntil!)} まで投票できません。</p>` : ''}
        ${excluded ? `<p class="notice" style="margin-bottom:8px">自己排除中：${fmtDate(s.selfExcludedUntil!)} まで投票できません。</p>` : ''}
        <p>期間中は観戦できますが、投票はできません。<b>設定した期間が終わるまで解除できません。</b></p>
        <div class="btn-row" style="margin-bottom:12px">
          <button class="btn" data-break="24">24時間休止</button>
          <button class="btn" data-break="168">7日間休止</button>
        </div>
        <div class="btn-row">
          <button class="btn btn-danger" data-exclude="30">30日間の自己排除</button>
          <button class="btn btn-danger" data-exclude="180">180日間の自己排除</button>
        </div>
        <p class="muted" style="font-size:.82rem;margin-top:8px">ギャンブルとの付き合い方に不安がある場合は、お住まいの地域の相談窓口にご相談ください。</p>
      </section>`
          : ''
      }

      <section class="card" aria-labelledby="disp-h"><h2 id="disp-h">表示設定</h2>
        <form data-form="prefs" class="grid grid-2">
          <label class="field"><span>映像</span><select name="viewer">
            <option value="3d" ${p.viewer === '3d' ? 'selected' : ''}>3D（対応端末のみ）</option>
            <option value="2d" ${p.viewer === '2d' ? 'selected' : ''}>2D 上空図（軽量）</option></select></label>
          <label class="field"><span>画質（3D）</span><select name="quality">
            ${(['auto', 'low', 'medium', 'high'] as Quality[]).map((q) => `<option value="${q}" ${p.quality === q ? 'selected' : ''}>${{ auto: '自動', low: '低', medium: '中', high: '高' }[q]}</option>`).join('')}</select></label>
          <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="reducedMotion" ${p.reducedMotion ? 'checked' : ''} style="width:20px;height:20px"> <span style="margin:0">動きを減らす（カメラの揺れ・切替を抑える）</span></label>
        </form>
      </section>

      <section class="card" aria-labelledby="aud-h"><h2 id="aud-h">監査ログ</h2>
        <p class="muted" style="font-size:.88rem">購入・締切・確定・払戻などの記録です。各記録は前の記録のハッシュを含むため、途中を書き換えると検出できます。</p>
        <button class="btn btn-sm" data-verify-audit>ログの整合性を検証</button> <span data-audit-msg aria-live="polite">${auditMsg}</span>
        <div class="table-wrap" style="max-height:320px;overflow-y:auto;margin-top:8px" tabindex="0" role="region" aria-label="監査ログの一覧（スクロールできます）"><table class="table">
          <thead><tr><th>#</th><th>日時</th><th>内容</th><th>ハッシュ</th></tr></thead>
          <tbody>${[...s.audit]
            .reverse()
            .slice(0, 100)
            .map(
              (a) => `<tr><td>${a.seq}</td><td class="tnum">${dateTime(a.ts)}</td><td>${AUDIT_LABEL[a.type] ?? a.type}<div class="entry-sub">${esc(
                Object.entries(a.data)
                  .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                  .join(' ')
                  .slice(0, 90),
              )}</div></td><td><code style="font-size:.75rem">${a.hash.slice(0, 12)}…</code></td></tr>`,
            )
            .join('')}</tbody></table></div>
      </section>

      <section class="card" aria-labelledby="data-h"><h2 id="data-h">データ</h2>
        <p class="muted" style="font-size:.88rem">データはこの端末のブラウザ内にのみ保存されています。</p>
        <button class="btn btn-danger" data-reset ${onBreak || excluded ? 'disabled aria-describedby="reset-note"' : ''}>すべてのデータを初期化</button>
        ${onBreak || excluded ? '<p id="reset-note" class="muted" style="font-size:.82rem">休止・自己排除の期間中は初期化できません。</p>' : ''}
      </section>`;
  };

  const confirmDialog = (title: string, body: string, ok: string): Promise<boolean> =>
    new Promise((resolve) => {
      let decided = false;
      const dlg = openDialog(
        `<div class="dialog-body"><h2>${title}</h2>${body}</div>
         <div class="dialog-actions"><button class="btn" data-close>やめる</button><button class="btn btn-danger" data-ok>${ok}</button></div>`,
        { label: title, onClose: () => !decided && resolve(false) },
      );
      dlg.querySelector('[data-ok]')!.addEventListener('click', () => {
        decided = true;
        dlg.close();
        resolve(true);
      });
    });

  const onSubmit = async (ev: Event) => {
    ev.preventDefault();
    const form = ev.target as HTMLFormElement;
    const fd = new FormData(form);
    if (form.dataset.form === 'profile') {
      store.set({ ...store.state, nickname: String(fd.get('nickname') ?? '').trim().slice(0, 20) || 'ゲスト' });
      toast('保存しました。');
    } else if (form.dataset.form === 'limits') {
      const cur = effectiveLimits(store.state, store.now());
      // 非表示の項目は現在の値をそのまま使う
      const n = (k: keyof Limits) => (fd.has(k) ? Math.max(0, Math.floor(Number(fd.get(k)) || 0)) : cur[k]);
      const next: Limits = {
        perRace: Math.floor(n('perRace') / 100) * 100,
        daily: Math.floor(n('daily') / 100) * 100,
        dailyLoss: Math.floor(n('dailyLoss') / 100) * 100,
        sessionReminderMin: n('sessionReminderMin'),
      };
      const { state, change } = changeLimits(store.state, next, store.now());
      store.set({ ...state, audit: await appendAudit(state.audit, 'limits_change', { ...next, applied: change.applied }, store.now()) });
      toast(change.applied === 'now' ? '上限を変更しました。' : `引き下げはすぐに、引き上げは ${fmtDate(change.effectiveAt)} に反映されます。`);
    }
  };

  const onChange = (ev: Event) => {
    const t = ev.target as HTMLInputElement | HTMLSelectElement;
    if (!t.closest('[data-form="prefs"]')) return;
    if (t.name === 'viewer') store.setPrefs({ viewer: t.value as '3d' | '2d' });
    if (t.name === 'quality') store.setPrefs({ quality: t.value as Quality });
    if (t.name === 'reducedMotion') store.setPrefs({ reducedMotion: (t as HTMLInputElement).checked });
    toast('表示設定を保存しました。');
  };

  const onClick = async (ev: Event) => {
    const t = ev.target as HTMLElement;
    const brk = t.closest<HTMLElement>('[data-break]');
    if (brk) {
      const hours = Number(brk.dataset.break);
      const label = hours === 24 ? '24時間' : '7日間';
      if (!(await confirmDialog(`${label}休止しますか？`, `<p>${label}は投票できなくなります。<b>期間中は解除できません。</b></p>`, '休止する'))) return;
      const s = startBreak(store.state, hours, store.now());
      store.set({ ...s, audit: await appendAudit(s.audit, 'break', { hours, until: s.breakUntil }, store.now()) });
      toast(`${label}の休止を開始しました。`);
      return;
    }
    const ex = t.closest<HTMLElement>('[data-exclude]');
    if (ex) {
      const days = Number(ex.dataset.exclude);
      if (!(await confirmDialog(`${days}日間の自己排除を設定しますか？`, `<p>${days}日間は投票できなくなり、<b>期間中は解除できません</b>。データの初期化もできなくなります。</p>`, '自己排除を設定する')))
        return;
      const s = selfExclude(store.state, days, store.now());
      store.set({ ...s, audit: await appendAudit(s.audit, 'self_exclusion', { days, until: s.selfExcludedUntil }, store.now()) });
      toast(`${days}日間の自己排除を設定しました。`);
      return;
    }
    if (t.closest('[data-verify-audit]')) {
      const r = await verifyAudit(store.state.audit);
      auditMsg = r.ok ? `<span class="pos">✓ ${r.count}件すべて整合しています</span>` : `<span class="neg">✗ #${r.brokenAt} で不整合を検出しました</span>`;
      el.querySelector('[data-audit-msg]')!.innerHTML = auditMsg;
      return;
    }
    if (t.closest('[data-reset]')) {
      if (!(await confirmDialog('データを初期化しますか？', '<p>残高・購入履歴・設定・監査ログがすべて消え、元に戻せません。</p>', '初期化する'))) return;
      await store.reset();
      toast('初期化しました。');
    }
  };

  return {
    title: 'アカウント設定',
    render(root) {
      el = root;
      draw();
      el.addEventListener('submit', onSubmit);
      el.addEventListener('change', onChange);
      el.addEventListener('click', onClick);
    },
    update(reason) {
      // 入力中のフォームを消さないよう、状態変化のときだけ再描画する
      const typing = document.activeElement?.matches('input, select') && el.contains(document.activeElement);
      if (reason === 'state' && !typing) draw();
    },
  };
}
