/// <reference lib="webworker" />
/** 確率推定を画面と別スレッドで行う（1レース約0.6秒かかるため） */
import type { RaceCard } from './meeting';
import { estimateProbabilities } from './probability';

self.onmessage = (ev: MessageEvent<{ card: RaceCard }>) => {
  const { card } = ev.data;
  (self as unknown as Worker).postMessage({ raceId: card.id, probs: estimateProbabilities(card) });
};
