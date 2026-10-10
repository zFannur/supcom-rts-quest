// Lite profile for standalone headsets (Meta Browser on Quest) or forced with ?lite in the URL (?lite=0 turns it off).
// Quest 3 has ~3 free CPU cores and a mobile GPU: small textures, no shadows/bloom/AA, coarser terrain, no HUD thumbnails.
// В статической сборке (dist, LITE_BUILD) полных моделей нет, поэтому LITE включён всегда.
import { LITE_BUILD } from './build.js';
const q = new URLSearchParams(location.search).get('lite');
export const LITE = LITE_BUILD || (q !== null ? q !== '0' : /OculusBrowser|Quest/i.test(navigator.userAgent));
// Пресеты качества VR (settings.vrQuality, меню VR). Модели: low = models_q (256 px), med/high = models_ktx (512 px KTX2). Масштаб кадра и фовеация
// применяются при входе в VR (WebXR не даёт менять их внутри сессии).
export const VR_PRESETS = { low: { scale: 0.8, fov: 1.0 }, med: { scale: 1.0, fov: 0.5 }, high: { scale: 1.2, fov: 0.3 } };
export const LITE_SETTINGS = { pixelRatio: 1, shadows: false, bloom: false, particles: 0, healthBars: 1 };
