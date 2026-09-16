/* bus.js — "방금 무슨 일이 일어났는가"를 알리는 곳.
 *
 *  스토어(store.js)와 역할이 다르다.
 *    · 스토어 = 지금 무엇이 있는가 (카탈로그·로그인 상태)      → 다시 그릴 때 읽는 진실
 *    · 버스   = 방금 무슨 일이 있었는가 (진행률·오류·토스트)   → 상태로 남을 필요 없는 일회성
 *
 *  데이터 층이 emit 하고 화면 층이 on 한다. 반대 방향은 없다.
 */

/** 쓰는 이벤트는 여기 다 적는다 — 오타로 조용히 안 불리는 일을 막는다. */
export const EVENTS = Object.freeze({
  AUTH_CHANGED: 'auth:changed',
  CATALOG_PROGRESS: 'catalog:progress',
  CATALOG_CHANGED: 'catalog:changed',
  DOC_READY: 'doc:ready',
  DOC_ERROR: 'doc:error',
  OUTBOX_CHANGED: 'outbox:changed',
  SYNC_PUSHED: 'sync:pushed',
  SYNC_PULLED: 'sync:pulled',
  STORAGE_FULL: 'storage:full',
  TOAST: 'toast',
});

const listeners = new Map();   // name → Set<fn>

export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => off(name, fn);           // 해제 함수를 돌려준다
}

export function off(name, fn) {
  listeners.get(name)?.delete(fn);
}

export function emit(name, payload) {
  const set = listeners.get(name);
  if (!set || !set.size) return;
  // 한 청취자가 던져도 나머지는 받아야 한다
  for (const fn of [...set]) {
    try { fn(payload); } catch (e) { console.error('[bus]', name, e); }
  }
}

/** 화면에 잠깐 띄우는 알림 — 어디서든 부를 수 있게 지름길을 둔다. */
export function toast(text, kind = 'info') {
  emit(EVENTS.TOAST, { text, kind });
}
