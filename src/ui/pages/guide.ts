import { BET_TYPES } from '../../core/bettypes';
import { CLOSE_INTERVAL_MS, FIRST_CLOSE_MS } from '../../core/raceflow';
import { BET_LIMITS_ENABLED, DEFAULT_LIMITS, SELF_EXCLUSION_ENABLED } from '../../core/responsible';
import { INITIAL_GRANT, REFILL_AMOUNT, REFILL_THRESHOLD } from '../../core/state';
import type { Page } from '../common';
import { coins, prefersReducedMotion } from '../util';

export function guidePage(): Page {
  return {
    title: '遊び方と仕組み',
    render(el) {
      el.innerHTML = `
        <h1>遊び方と仕組み</h1>
        <nav class="card" aria-label="目次" style="margin-bottom:16px">
          <ol style="margin:0;padding-left:1.2em;columns:2">
            <li><a href="#/guide" data-jump="g-steps">遊び方</a></li>
            <li><a href="#/guide" data-jump="g-coin">デモコイン</a></li>
            <li><a href="#/guide" data-jump="g-types">券種</a></li>
            <li><a href="#/guide" data-jump="g-odds">オッズと払戻</a></li>
            <li><a href="#/guide" data-jump="g-flow">発売から確定まで</a></li>
            <li><a href="#/guide" data-jump="g-sim">レース結果の決まり方</a></li>
            <li><a href="#/guide" data-jump="g-fair">公正性</a></li>
            <li><a href="#/guide" data-jump="g-rg">責任ある利用</a></li>
          </ol>
        </nav>

        <section class="card" id="g-steps"><h2>遊び方（3ステップ）</h2>
          <ol class="steps">
            <li><div><b>検討する</b>：レース一覧からレースを選び、出走表で選手の級別・勝率・平均ST、モーター、展示タイム、水面条件とオッズを確認します。選手名を選ぶと能力値の詳細が見られます。</div></li>
            <li><div><b>投票する</b>：券種と艇を選び、賭け金を入力して「購入内容を確認」。オッズ・想定払戻・購入後の残高を確認してから購入します。</div></li>
            <li><div><b>観戦・振り返り</b>：締切後にスタートし、3D（または2D上空図）で観戦できます。確定後に着順・決まり手・払戻・収支・勝因が表示されます。</div></li>
          </ol>
        </section>

        <section class="card" id="g-coin"><h2>デモコイン</h2>
          <ul>
            <li>はじめに <b>${coins(INITIAL_GRANT)}コイン</b> を受け取ります。</li>
            <li><b>購入・換金・譲渡はできず、金銭的な価値はありません。</b>景品との交換もありません。</li>
            <li>残高が ${coins(REFILL_THRESHOLD)}コイン未満になると、1日1回だけ ${coins(REFILL_AMOUNT)}コインを補充できます（「収支」画面）。</li>
          </ul>
        </section>

        <section class="card" id="g-types"><h2>券種</h2>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>券種</th><th>当て方</th><th class="r">控除率（デモ設定）</th></tr></thead>
            <tbody>${BET_TYPES.map((t) => `<tr><td><b>${t.label}</b></td><td>${t.description}</td><td class="r">${(t.takeout * 100).toFixed(1)}%</td></tr>`).join('')}</tbody>
          </table></div>
          <p class="muted" style="font-size:.85rem">はじめての方は、1艇を選ぶだけの「単勝」か、2着以内に入れば当たる「複勝」がおすすめです。<b>フライング（F）・出遅れ（L）</b>の艇を含む券は全額返還されます。完走艇が足りず組み合わせが作れない券種は「不成立」として全額返還します。</p>
        </section>

        <section class="card" id="g-odds"><h2>オッズと払戻</h2>
          <p>オッズは<b>パリミュチュエル方式</b>（投票プール方式）で決まります。すべての投票をプールし、主催者の控除分を差し引いた残りを、的中した人で分け合います。</p>
          <pre style="white-space:pre-wrap;background:var(--bg);padding:12px;border-radius:8px;font-size:.9rem">オッズ ＝ プール総額 ×（1 − 控除率）÷ その組み合わせへの投票額
払戻額 ＝ 賭け金 × 確定オッズ   （0.1倍未満は切り捨て、最低1.0倍）</pre>
          <p><b>計算例</b>：単勝のプール総額が100万コイン、控除率25%、3号艇への投票が15万コインなら、
          オッズは 100万×0.75÷15万＝<b>5.0倍</b>。300コイン賭けて的中すると <b>1,500コイン</b> が払い戻されます。</p>
          <ul>
            <li><b>変動中</b>：発売中は他の利用者の投票（デモでは模擬）によってオッズが変わります。</li>
            <li><b>確定</b>：締切時点のプールでオッズが確定し、払戻はこの確定オッズで計算されます。購入時に表示されたオッズとは異なることがあります。</li>
            <li><b>複勝・拡連複</b>は、一緒に的中する他の組み合わせによって払戻が変わるため、確定まで幅（下限〜上限）で表示します。</li>
            <li>オッズは「人気の目安」であり、勝つ確率そのものではありません。</li>
          </ul>
        </section>

        <section class="card" id="g-flow"><h2>発売から確定まで</h2>
          <ol>
            <li><b>発売中</b>：開催開始の${FIRST_CLOSE_MS / 60000}分後に1Rが締め切られ、以降${CLOSE_INTERVAL_MS / 60000}分おきに締め切られます（デモ用の短い間隔）。「今すぐ締切して発走」で早めることもできます。</li>
            <li><b>締切</b>：購入できなくなり、オッズが確定します。</li>
            <li><b>発走</b>：待機行動のあと、大時計に合わせて<b>フライングスタート</b>（0〜1秒の間にスタートラインを通過）。生中継として観戦できます。</li>
            <li><b>確定</b>：全艇がゴールしたら着順と払戻が確定し、残高に反映されます。リプレイはいつでも見られます。</li>
          </ol>
          <p class="muted" style="font-size:.85rem">画面を閉じている間に締切を迎えたレースも、次に開いたときに同じ結果で確定します。</p>
        </section>

        <section class="card" id="g-sim"><h2>レース結果の決まり方</h2>
          <p>結果は、0.05秒ごとに全艇の位置と速度を計算するシミュレーションで決まります。1周600mを3周（1,800m）、左回りです。主な要素：</p>
          <ul>
            <li><b>スタート</b>：選手の平均ST（スタートタイミング）に毎回のばらつきが加わります。0秒より早いとフライング、1秒より遅いと出遅れで返還欠場。1〜3コースは助走が短いスロー、4〜6コースは助走が長いダッシュです。</li>
            <li><b>1マーク</b>：先にマークへ着いた艇が内側を回ります。内の艇より十分前に出ていれば外から内へ切り込み（まくり）、少し遅れていれば内の艇の後ろから内を突きます（差し）。</li>
            <li><b>ターン</b>：内側ほど距離は短いが速度は落ちます。ターン技術・モーターで旋回速度が、波・潮でターンの流れ（外へ膨らむ量）が変わります。</li>
            <li><b>引き波</b>：前の艇の真後ろを走ると減速します。</li>
            <li><b>モーター・体重・水面</b>：モーターの性能と選手の伸び・体重が直線の速さに、潮・風・波が直線とターンに影響します。上げ潮はスロー勢、下げ潮はダッシュ勢に向くと言われます。</li>
          </ul>
          <p><b>水面</b>：形状は江戸川（河川を利用した水面）の公開情報を参考にした<b>非公式の再現</b>です。1マーク付近の幅が約37mと狭くスタンド寄りにあること、潮の干満や風で水面が荒れやすいことを取り入れ、1コースの1着率は全国平均より低め（約46〜48%）になるよう調整しています。寸法の多くは推定で、実在のレース場・団体とは関係ありません。</p>
          <p>レース後には、スタートや1マークの攻防など結果に効いた要素が表示されます。能力が高い選手でも負けることがあり、<b>勝利が保証されることはありません</b>。</p>
        </section>

        <section class="card" id="g-fair"><h2>公正性（結果を操作できない仕組み）</h2>
          <ol>
            <li>発売開始時に、結果を決める乱数の種（seed）を作り、その<b>ハッシュ値だけ</b>を公開します。</li>
            <li>締切後、seed からレースを計算します。オッズの推定には別の公開された乱数を使うため、オッズから結果は分かりません。</li>
            <li>確定後に seed を公開します。「結果」タブの検証ボタンで、ハッシュの一致と着順の再現を誰でも確認できます。</li>
            <li>購入・締切・結果・払戻は、改ざんを検出できる監査ログ（ハッシュチェーン）に記録されます（「設定」で検証できます）。</li>
          </ol>
          <p class="muted" style="font-size:.85rem">デモでは端末内で計算しています。本番では結果をサーバー側だけで計算し、seed を厳重に管理します。</p>
        </section>

        <section class="card" id="g-rg"><h2>責任ある利用</h2>
          <ul>
            ${
              BET_LIMITS_ENABLED
                ? `<li>投票上限（初期値）：1レース ${coins(DEFAULT_LIMITS.perRace)}／1日 ${coins(DEFAULT_LIMITS.daily)}コイン、1日の損失上限 ${coins(DEFAULT_LIMITS.dailyLoss)}コイン。</li>
                   <li>上限の引き下げはすぐに、引き上げは24時間後に反映されます。</li>`
                : '<li>投票上限（1レース・1日・損失）は、現在デモ設定でオフにしています。残高の範囲で自由に投票できます。</li>'
            }
            <li>${DEFAULT_LIMITS.sessionReminderMin}分ごとに利用時間と収支をお知らせします。</li>
            ${SELF_EXCLUSION_ENABLED ? '<li>24時間・7日の一時休止、30日以上の自己排除を設定できます（期間中は解除できません）。</li>' : ''}
          </ul>
          <p><a class="btn" href="#/account">設定を開く</a></p>
        </section>`;

      // ハッシュルーターと衝突しないよう、目次はスクロールで移動する
      el.querySelectorAll<HTMLAnchorElement>('[data-jump]').forEach((a) =>
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          const target = document.getElementById(a.dataset.jump!);
          target?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
          target?.setAttribute('tabindex', '-1');
          target?.focus({ preventScroll: true });
        }),
      );
    },
  };
}
