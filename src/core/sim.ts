/**
 * ボートレースのシミュレーター（決定論的・0.05秒刻みのエージェントモデル）。
 *
 * 同じ (条件, 出走艇, seed) からは常に同じ結果を返す。映像は走行ログを再生するだけ。
 *
 * - スタート：平均STにばらつきを加えた ST でスタートラインを通過。ST<0 はフライング（F）、ST>1.0 は出遅れ（L）で返還欠場
 *   スロー（1〜3コース）は助走が短く、ダッシュ（4〜6コース）は助走が長くライン通過時の速度が速い
 * - ターン：先にマークへ着いた艇が内側の線を取り、並ばれた艇は外を回る（差し・まくりが自然に生まれる）
 *   ターン速度は旋回半径とターン技術・モーターで決まり、出口では技術・波・潮に応じて外へ流れる
 * - 引き波：前の艇の真後ろでは減速する
 * - 江戸川の特徴（推定）：1マークがスタンド寄りで幅が狭く、内の艇が流れやすい。潮と風が直線の速さに、波がターンに影響する
 */
import type { Racer } from '../data/racers';
import { DISTANCE, LAP, R0, SEGMENTS, lapPos, nextTurn, pointAt, widthAt } from './course';
import { Rng } from './rng';

export const ENGINE_VERSION = 'boat-1.0.0';

export type Weather = 'sunny' | 'cloudy' | 'rain';
export type Tide = 'rising' | 'falling' | 'slack';
export type TimeOfDay = 'day' | 'dusk' | 'night';

export const WEATHER_LABEL: Record<Weather, string> = { sunny: '晴', cloudy: '曇', rain: '雨' };
export const TIDE_LABEL: Record<Tide, string> = { rising: '上げ潮', falling: '下げ潮', slack: '潮止まり' };
export const TIME_LABEL: Record<TimeOfDay, string> = { day: 'デイ', dusk: '薄暮', night: 'ナイター' };

export interface RaceConditions {
  distance: number;
  weather: Weather;
  /** 風速 (m/s)。正はホームストレッチの進行方向への追い風 */
  wind: number;
  /** 波高 (cm) */
  wave: number;
  tide: Tide;
  timeOfDay: TimeOfDay;
}

export interface Motor {
  no: number;
  /** モーター2連対率 (%) */
  rate: number;
  /** 隠れた性能 0-100（2連対率と相関） */
  power: number;
}

export interface SimBoat {
  racer: Racer;
  /** 艇番（＝進入コース、枠なり） */
  number: number;
  motor: Motor;
  boatNo: number;
}

export type Flag = 'F' | 'L' | null;
export type Kimarite = '逃げ' | '差し' | 'まくり' | 'まくり差し' | '抜き' | '恵まれ';

export interface SimEvent {
  t: number;
  type: 'start' | 'flying' | 'late' | 'turn' | 'lap' | 'lead' | 'finish';
  runner: number;
  turn?: number;
  lap?: number;
}

export interface BoatFactors {
  st: number;
  flag: Flag;
  topSpeed: number;
  turnSkill: number;
  /** 1マーク進入時の横の位置 */
  entryD1M: number;
  /** 1マーク出口の順位 */
  rankAfter1M: number;
  /** 引き波を受けた時間 (s) */
  wakeTime: number;
  /** 1マークで流れた量 (m) */
  drift1M: number;
}

export interface SimResult {
  dt: number;
  n: number;
  frames: number;
  /** 映像の時刻0はスタート合図の LEAD 秒前 */
  lead: number;
  /** [frame][runner][x(走行距離 s + 助走), lane(d), v] */
  data: Float32Array | null;
  /** 映像の時刻でのゴール時刻（欠場は Infinity） */
  finishTimes: number[];
  /** 着順（完走艇の runner index）。欠場艇は含まない */
  order: number[];
  excluded: number[];
  flags: Flag[];
  st: number[];
  /** レースタイム（スタート合図から、秒） */
  raceTimes: number[];
  kimarite: Kimarite;
  turnOrders: { turn: number; order: number[] }[];
  events: SimEvent[];
  factors: BoatFactors[];
  /** 表示用：前の艇との差 */
  margins: string[];
}

export interface SimOptions {
  dt?: number;
  record?: boolean;
}

/** 調整用の定数（テストで分布を確認しながら決めた値） */
export const TUNE = {
  vmax: 20.2,
  aLat: 8.6,
  acc: 1.8,
  drift: 1.0,
  stSd: 0.03,
  vSlow: 17.5,
  vDash: 20.6,
  sideBySide: 0.5,
  crossBase: 1.5,
  crossK: 0.25,
  turnSd: 0.05,
  inDrift: 1.6,
  vMotor: 0.022,
  laterDrift: 1,
};

/** スタート合図の何秒前から映像を始めるか（大時計が回り、艇がスタートラインへ向かう） */
export const LEAD = 6;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function formatRaceTime(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}'${s.toFixed(1).padStart(4, '0').replace('.', '"')}`;
}

export function simulateRace(cond: RaceConditions, boats: SimBoat[], seed: string, opts: SimOptions = {}): SimResult {
  const dt = opts.dt ?? 0.05;
  const record = opts.record ?? true;
  const rng = new Rng(`${seed}|${ENGINE_VERSION}`);
  const n = boats.length;
  const waveK = cond.wave / 10; // 10cm で 1
  // 潮：上げ潮はホームストレッチ（スタート方向）に逆らう流れ、下げ潮は追う流れ（推定）
  const current = cond.tide === 'rising' ? -0.5 : cond.tide === 'falling' ? 0.5 : 0;

  // ---- 艇ごとのパラメータ（乱数の消費順は固定） ----
  const T = TUNE;
  const P = boats.map((b) => {
    const r = b.racer;
    const lane = b.number;
    const cond0 = rng.normal(0, 0.12);
    const vmax = T.vmax + (b.motor.power - 50) * T.vMotor + (r.speed - 70) * 0.012 - (r.weight - 51) * 0.035 + cond0;
    const aLat = T.aLat + (r.turn - 70) * 0.04 + (b.motor.power - 50) * 0.008;
    // ターンの流れ（m）：技術が低い・波が高い・潮が強いほど大きい
    const driftSd = T.drift + ((100 - r.turn) / 100) * 2.5 + waveK * 1.6 * ((100 - r.wave) / 100) + Math.abs(current) * 1.2;
    // スタート：平均ST にばらつき。スタート技術が高いほど安定
    let st = r.avgST + rng.normal(0, T.stSd + (T.stSd * (100 - r.start)) / 40);
    // 上げ潮はスロー有利、下げ潮はダッシュ有利（と言われる）
    st += (lane >= 4 ? 1 : -1) * (cond.tide === 'rising' ? 0.01 : cond.tide === 'falling' ? -0.01 : 0);
    const lateTrouble = rng.chance(0.002);
    if (lateTrouble) st = 1.05 + rng.next() * 0.3;
    const flag: Flag = st < 0 ? 'F' : st > 1.0 ? 'L' : null;
    // ライン通過時の速度：ダッシュ勢（4〜6コース）は助走が長く速い
    const vLine = (lane >= 4 ? T.vDash : T.vSlow) + (b.motor.power - 50) * 0.01;
    return { lane, vmax, aLat, driftSd, st, flag, vLine, turnSkill: r.turn };
  });

  // ---- 状態 ----
  const s = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Float64Array(n);
  const dTarget = new Float64Array(n);
  const finishT = new Array<number>(n).fill(Infinity);
  const wakeT = new Float64Array(n);
  const retired = P.map((p) => p.flag !== null);
  const entryD1M = new Float64Array(n).fill(NaN);
  const drift1M = new Float64Array(n);
  const turnDrift = new Float64Array(n);
  const assignedTurn = new Int32Array(n).fill(-1);
  const turnQ = new Float64Array(n).fill(1);
  const crossed1M = new Array<boolean>(n).fill(false);
  const entryS1M = new Float64Array(n).fill(-Infinity);
  const events: SimEvent[] = [];
  const turnOrders: { turn: number; order: number[] }[] = [];
  const turnPassed = new Set<number>();

  // スタート合図の LEAD 秒前の位置（一定速度でラインへ向かう）
  P.forEach((p, i) => {
    s[i] = -(LEAD + p.st) * p.vLine;
    d[i] = 3 + (p.lane - 1) * 5.2;
    dTarget[i] = d[i];
    v[i] = p.vLine;
  });

  const maxT = LEAD + 140;
  const maxFrames = Math.ceil(maxT / dt) + 2;
  const data = record ? new Float32Array(maxFrames * n * 3) : null;
  let frame = 0;
  const write = () => {
    if (!data) return;
    const base = frame * n * 3;
    for (let i = 0; i < n; i++) {
      data[base + i * 3] = s[i];
      data[base + i * 3 + 1] = d[i];
      data[base + i * 3 + 2] = v[i];
    }
  };
  write();
  frame++;

  let t = 0; // 映像の時刻（スタート合図は t = LEAD）
  let lastLeader = -1;
  let done = 0;
  const active = () => P.filter((_, i) => !retired[i]).length;

  while (t < maxT && !(done >= active() && t > Math.max(...finishT.filter(Number.isFinite), LEAD) + 3)) {
    const sPrev = Float64Array.from(s);
    const dPrev = Float64Array.from(d);

    // ターン進入の割り当て：先頭がターン入口の45m手前に来たら、前の艇から順に内側の線を決める
    for (let i = 0; i < n; i++) {
      if (retired[i] || finishT[i] < Infinity || sPrev[i] < 0) continue;
      const nt = nextTurn(sPrev[i]);
      if (nt.dist < 45 && assignedTurn[i] !== nt.index) {
        // このターンに近い艇をまとめて割り当てる
        const group = Array.from({ length: n }, (_, k) => k).filter((k) => !retired[k] && finishT[k] === Infinity && sPrev[k] > 0 && nextTurn(sPrev[k]).index === nt.index && assignedTurn[k] !== nt.index);
        group.sort((a, b) => sPrev[b] - sPrev[a]);
        const placed: { k: number; d: number; s: number }[] = [];
        const isFirst1M = nt.index === 0;
        // 内側の艇に道を譲った艇（その艇の処理では邪魔にならない）
        const yielded = new Map<number, Set<number>>();
        for (const k of group) {
          let want = 2;
          let crossed = true;
          // 前の艇：完全に並んでいれば外を回る。少し後ろならその艇の後ろについて内を差す
          for (const pl of placed) {
            const g = pl.s - sPrev[k];
            if (g > 14 || yielded.get(pl.k)?.has(k)) continue;
            if (g < T.sideBySide) want = Math.max(want, pl.d + 4);
          }
          // 内側にいる後ろの艇：十分に前に出ていなければ、その艇の前を横切れない（外を回る）
          const innerBehind = group.filter(
            (i2) => i2 !== k && dPrev[i2] < dPrev[k] && sPrev[i2] <= sPrev[k] && !placed.some((pl) => pl.k === i2),
          );
          let blockers = 0;
          for (const i2 of innerBehind) {
            const need = T.crossBase + T.crossK * (dPrev[k] - dPrev[i2]);
            if (sPrev[k] - sPrev[i2] < need) {
              blockers++;
              crossed = false;
              const set = yielded.get(k) ?? new Set<number>();
              set.add(i2);
              yielded.set(k, set);
            }
          }
          if (blockers > 0) want = Math.max(want, 2 + 4 * blockers);
          // まくり：内側の艇の前を横切って最内を取った
          crossed = crossed && innerBehind.length > 0 && want === 2 && placed.every((pl) => pl.s - sPrev[k] >= 14);
          // 1マーク付近は狭い（江戸川：約37m）
          want = Math.min(want, widthAt(sPrev[k] + nt.dist) - 4);
          dTarget[k] = want;
          placed.push({ k, d: want, s: sPrev[k] });
          assignedTurn[k] = nt.index;
          // ターン精度（旋回の良し悪し）と流れ
          turnQ[k] = 1 + rng.normal(0, T.turnSd);
          // 江戸川の特徴（推定）：1周目1マークのインは幅が狭く波を受けやすいため流れやすい
          const inner1M = isFirst1M && want <= 3 && P[k].lane <= 2;
          turnDrift[k] = Math.abs(rng.normal(0, P[k].driftSd)) * (inner1M ? T.inDrift : isFirst1M ? 1 : T.laterDrift);
          if (isFirst1M) {
            entryD1M[k] = want;
            entryS1M[k] = sPrev[k];
            crossed1M[k] = crossed && want <= 3;
          }
        }
      }
    }

    for (let i = 0; i < n; i++) {
      const p = P[i];
      if (finishT[i] < Infinity) {
        // ゴール後は減速して流す
        v[i] = Math.max(6, v[i] - 3 * dt);
        s[i] += v[i] * dt;
        continue;
      }
      if (retired[i] && sPrev[i] > 5) {
        // フライング・出遅れ：外へ避けて減速し、レースから外れる
        v[i] = Math.max(4, v[i] - 4 * dt);
        dTarget[i] = 38;
        d[i] += clamp(dTarget[i] - d[i], -4 * dt, 4 * dt);
        s[i] += v[i] * dt;
        continue;
      }
      const u = lapPos(sPrev[i]);
      const here = pointAt(sPrev[i], dPrev[i]);
      const nt = nextTurn(sPrev[i]);
      const R = R0 + dPrev[i];

      // 目標速度：直線は最高速度（潮・風・波の影響）、ターンは旋回半径で決まる速度
      const straightDir = here.heading === 0 ? 1 : here.heading === Math.PI ? -1 : 0;
      let target = p.vmax + straightDir * (current * 0.6 + cond.wind * 0.05) - waveK * 0.25;
      const vTurn = Math.min(p.vmax, Math.sqrt(p.aLat * turnQ[i] * (R0 + dTarget[i])));
      if (here.onTurn) target = Math.sqrt(p.aLat * turnQ[i] * R);
      else if (nt.dist < 30 && sPrev[i] > 0) target = Math.min(target, vTurn + (nt.dist / 30) * (target - vTurn));
      // スタート前は一定速度
      if (t < LEAD + p.st) target = p.vLine;

      // 引き波：前の艇の真後ろ（25m以内・横2.5m以内）
      for (let k = 0; k < n; k++) {
        if (k === i || retired[k] || finishT[k] < Infinity) continue;
        const ds = sPrev[k] - sPrev[i];
        if (ds > 2 && ds < 25 && Math.abs(dPrev[k] - dPrev[i]) < 2.5) {
          target *= 0.95;
          if (sPrev[i] > 0) wakeT[i] += dt;
          break;
        }
      }
      // 前の艇にぶつからない（同じ線で6m以内なら前の艇の速度まで）
      for (let k = 0; k < n; k++) {
        if (k === i || retired[k]) continue;
        const ds = sPrev[k] - sPrev[i];
        if (ds > 0 && ds < 6 && Math.abs(dPrev[k] - dPrev[i]) < 2.2) target = Math.min(target, v[k]);
      }

      const acc = target > v[i] ? T.acc + (p.vmax - T.vmax) * 0.3 : -7;
      v[i] = target > v[i] ? Math.min(target, v[i] + acc * dt) : Math.max(target, v[i] + acc * dt);
      const vEff = Math.max(0, v[i] + rng.normal(0, 0.05));

      // 横の動き：ターン中は流れ、直線では割り当てた線へ（ターン後は少し内へ戻す）
      if (here.onTurn) {
        const prog = here.turnIndex === 0 ? (u - SEGMENTS.turn1Start) / (Math.PI * R0) : (u - SEGMENTS.turn2Start) / (Math.PI * R0);
        const want = dTarget[i] + turnDrift[i] * Math.sin(Math.PI * clamp(prog, 0, 1) * 0.5);
        d[i] += clamp(want - d[i], -3 * dt, 3 * dt);
        if (nt.index === 0 || (assignedTurn[i] === 0 && lapPos(sPrev[i]) < SEGMENTS.turn1End)) drift1M[i] = Math.max(drift1M[i], d[i] - dTarget[i]);
      } else if (sPrev[i] > 0) {
        if (nt.dist > 60) dTarget[i] = Math.max(dTarget[i] - 0.6 * dt, 3 + Math.min(4, i * 0.6));
        d[i] += clamp(dTarget[i] - d[i], -2.5 * dt, 2.5 * dt);
      }
      const width = widthAt(sPrev[i]);
      d[i] = clamp(d[i], 1, width - 1);

      // 前進（ターン中は外を回るほど内側の線に沿った進みが減る）
      const prog = here.onTurn ? (vEff * dt * R0) / R : vEff * dt;
      s[i] = sPrev[i] + prog;

      // スタート判定
      if (sPrev[i] < 0 && s[i] >= 0) {
        events.push({ t, type: p.flag === 'F' ? 'flying' : p.flag === 'L' ? 'late' : 'start', runner: i });
      }
      // ゴール
      if (!retired[i] && sPrev[i] < DISTANCE && s[i] >= DISTANCE) {
        finishT[i] = t + (dt * (DISTANCE - sPrev[i])) / (s[i] - sPrev[i]);
        done++;
        events.push({ t: finishT[i], type: 'finish', runner: i });
      }
    }

    // ターン出口の順位（先頭がターン出口を過ぎたとき）
    const racing = Array.from({ length: n }, (_, k) => k).filter((k) => !retired[k]);
    const leadS = Math.max(...racing.map((k) => s[k]));
    for (let ti = 0; ti < LAP * 3; ti++) {
      const exitS = Math.floor(ti / 2) * LAP + (ti % 2 === 0 ? SEGMENTS.turn1End : SEGMENTS.turn2End) + 50;
      if (exitS > DISTANCE) break;
      if (!turnPassed.has(ti) && leadS >= exitS) {
        turnPassed.add(ti);
        const order = [...racing].sort((a, b) => s[b] - s[a]);
        turnOrders.push({ turn: ti, order });
        events.push({ t, type: 'turn', runner: order[0], turn: ti });
      }
      if (exitS > leadS) break;
    }
    // 周回
    for (let lap = 1; lap < 3; lap++) {
      const prevLead = Math.max(...racing.map((k) => sPrev[k]));
      if (prevLead < lap * LAP && leadS >= lap * LAP) events.push({ t, type: 'lap', runner: racing.sort((a, b) => s[b] - s[a])[0], lap });
    }
    // 先頭交代（スタート後）
    if (leadS > 60) {
      const leader = racing.reduce((a, b) => (s[b] > s[a] ? b : a), racing[0]);
      if (lastLeader !== -1 && leader !== lastLeader) events.push({ t, type: 'lead', runner: leader });
      lastLeader = leader;
    }

    t += dt;
    write();
    frame++;
    if (frame >= maxFrames) break;
  }

  // 完走しなかった艇（通常は発生しない）は現在位置から推定
  for (let i = 0; i < n; i++) {
    if (!retired[i] && finishT[i] === Infinity) finishT[i] = t + (DISTANCE - s[i]) / Math.max(1, v[i]);
  }
  const excluded = P.map((p, i) => (p.flag ? i : -1)).filter((i) => i >= 0);
  const order = Array.from({ length: n }, (_, i) => i)
    .filter((i) => !retired[i])
    .sort((a, b) => finishT[a] - finishT[b]);

  // 1マーク出口の順位
  const after1M = turnOrders.find((o) => o.turn === 0)?.order ?? order;
  const rankAfter1M = (i: number) => after1M.indexOf(i) + 1;

  // 決まり手
  let kimarite: Kimarite = '抜き';
  const w = order[0];
  if (w !== undefined && rankAfter1M(w) === 1) {
    const inner = [...Array(n).keys()].filter((k) => P[k].lane < P[w].lane);
    const innerRacing = inner.filter((k) => !retired[k]);
    if (P[w].lane === 1) kimarite = '逃げ';
    else if (innerRacing.length === 0) kimarite = '恵まれ';
    else {
      // 1マークで自分より内側の線を回った艇
      const insideOfW = innerRacing.filter((k) => entryD1M[k] < entryD1M[w] - 0.5);
      // 内側の艇がすべて自分より内を回ったとき：最初に回った艇が流れて、その内を突いていれば「まくり差し」
      const firstTurner = innerRacing.reduce((a, b) => (entryS1M[b] > entryS1M[a] ? b : a), innerRacing[0]);
      const cutInside = entryD1M[firstTurner] + drift1M[firstTurner] > entryD1M[w] - 1.5;
      if (crossed1M[w]) kimarite = 'まくり';
      else if (insideOfW.length === innerRacing.length) kimarite = cutInside ? 'まくり差し' : 'まくり';
      else if (insideOfW.length === 0) kimarite = '差し';
      else kimarite = 'まくり差し';
    }
  }

  const margins = new Array<string>(n).fill('');
  for (let k = 1; k < order.length; k++) {
    const gap = finishT[order[k]] - finishT[order[k - 1]];
    margins[order[k]] = gap < 0.15 ? 'ハナ' : gap < 0.5 ? '僅差' : `${(gap * 20).toFixed(0)}m`;
  }

  const factors: BoatFactors[] = P.map((p, i) => ({
    st: p.st,
    flag: p.flag,
    topSpeed: p.vmax,
    turnSkill: p.turnSkill,
    entryD1M: entryD1M[i],
    rankAfter1M: rankAfter1M(i),
    wakeTime: wakeT[i],
    drift1M: drift1M[i],
  }));

  events.sort((a, b) => a.t - b.t);
  return {
    dt,
    n,
    frames: frame,
    lead: LEAD,
    data: data ? data.subarray(0, frame * n * 3) : null,
    finishTimes: finishT.map((f, i) => (retired[i] ? Infinity : f)),
    order,
    excluded,
    flags: P.map((p) => p.flag),
    st: P.map((p) => p.st),
    raceTimes: finishT.map((f, i) => (retired[i] ? Infinity : f - LEAD)),
    kimarite,
    turnOrders,
    events,
    factors,
    margins,
  };
}

/** 走行ログから時刻 time の各艇の状態を線形補間で取り出す（描画用） */
export function sampleAt(res: SimResult, time: number, out: { x: number; lane: number; v: number }[]): void {
  if (!res.data) throw new Error('record=false の結果からはサンプリングできません');
  const f = clamp(time / res.dt, 0, res.frames - 1);
  const f0 = Math.floor(f);
  const f1 = Math.min(res.frames - 1, f0 + 1);
  const a = f - f0;
  const dd = res.data;
  for (let i = 0; i < res.n; i++) {
    const b0 = (f0 * res.n + i) * 3;
    const b1 = (f1 * res.n + i) * 3;
    const o = out[i] ?? (out[i] = { x: 0, lane: 0, v: 0 });
    o.x = dd[b0] + (dd[b1] - dd[b0]) * a;
    o.lane = dd[b0 + 1] + (dd[b1 + 1] - dd[b0 + 1]) * a;
    o.v = dd[b0 + 2] + (dd[b1 + 2] - dd[b0 + 2]) * a;
  }
}

export { LAP };
