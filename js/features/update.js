/* update.js — 앱 갱신. "왜 새 기능이 안 보이지"를 없애는 곳.
 *
 *  ‼ "앱을 다시 열면 적용됩니다"로는 갱신이 안 먹는다. 설치형 PWA 는 좀처럼
 *    완전히 닫히지 않아 옛 셸이 계속 산다 — 실제로 "설정 화면은 뜨는데 새 단추가
 *    없다"로 나타났다. 그래서 **한 번 누르면** 새 워커를 깨워 바로 바꿔 끼운다.
 *
 *  ‼ 서비스워커가 같은 출처 자산을 받을 때 HTTP 캐시를 건너뛰게 한 것과 한 쌍이다
 *    (sw.js 의 `cache: 'no-cache'`). 둘 중 하나만 있으면 갱신이 늦게 먹는다.
 */
import * as shell from './shell.js';
import * as log from '../core/log.js';
import { auth } from '../data/index.js';

let waitingSW = null;

export function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(sw);
      });
    });
    // 앱을 앞으로 꺼낼 때마다 새 판이 있는지 확인한다
    const poke = () => { reg.update().catch(() => {}); };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') poke();
    });
    setInterval(poke, 60 * 60 * 1000);
  }).catch(e => log.warn('sw', '등록 실패', e));

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    auth.postTokenToSW();
    if (!reloading && waitingSW) { reloading = true; location.reload(); }
  });
}

function offerUpdate(sw) {
  waitingSW = sw;
  shell.banner('새 버전이 있습니다.', { action: '지금 적용', onAction: applyUpdate });
}

export function applyUpdate() {
  if (!waitingSW) { location.reload(); return; }
  waitingSW.postMessage('skipWaiting');       // controllerchange 가 오면 새로고침한다
}

/** 설정 화면의 "앱 갱신 확인". 새 판이 있으면 배너가 뜬다. */
export async function checkUpdate() {
  const reg = await navigator.serviceWorker?.getRegistration?.();
  if (!reg) return { ok: false, reason: '서비스워커가 없습니다' };
  await reg.update();
  if (reg.waiting) { offerUpdate(reg.waiting); return { ok: true, found: true }; }
  return { ok: true, found: false };
}

/** 지금 도는 셸이 몇 판인지 — 서비스워커에게 직접 묻는다. */
export function runningVersion() {
  return new Promise((resolve) => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) { resolve(''); return; }
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(''), 1500);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data?.version || ''); };
    try { sw.postMessage({ type: 'version' }, [ch.port2]); } catch (e) { resolve(''); }
  });
}

