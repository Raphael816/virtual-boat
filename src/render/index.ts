import type { RaceViewer } from './types';
import { Viewer2D } from './viewer2d';

export interface ViewerPrefs {
  viewer: '3d' | '2d';
  quality: 'auto' | 'low' | 'medium' | 'high';
  reducedMotion: boolean;
}

export interface ViewerHooks {
  /** 3D の描画を続けられなくなったとき（呼び出し側で2Dに切り替える） */
  onFail: (reason: string) => void;
  onQualityChange?: (label: string) => void;
}

/**
 * 表示設定と端末の対応状況から映像の描画方式を選ぶ。
 * three.js は 3D を使うときだけ動的に読み込む（初回表示を軽くするため）。
 * WebGL が使えない・読み込みに失敗した場合は 2D 上空図を返す。
 */
export async function createViewer(prefs: ViewerPrefs, hooks: ViewerHooks): Promise<RaceViewer> {
  if (prefs.viewer === '3d') {
    try {
      const mod = await import('./three/viewer3d');
      if (mod.webglAvailable()) {
        return new mod.Viewer3D({
          quality: prefs.quality,
          reducedMotion: prefs.reducedMotion,
          onFail: hooks.onFail,
          onQualityChange: hooks.onQualityChange,
        });
      }
    } catch (e) {
      console.warn('3D viewer unavailable', e);
    }
  }
  return new Viewer2D();
}
