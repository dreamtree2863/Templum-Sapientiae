/* kv.js — localStorage 안전 래퍼.
 *
 *  ‼ 옛 app.js:245 는 저장 실패를 `catch(_) {}` 로 삼켰다. 9,335개 목록이
 *    5MB 한도에 걸려 **조용히** 저장되지 않아도 아무도 몰랐다.
 *    여기서는 한도 초과를 반드시 위로 알린다(storage:full) — 조용한 실패 금지.
 *
 *  큰 것(카탈로그·아웃박스)은 여기 두지 않는다. idb.js 를 쓴다.
 *  여기 남는 것: 토큰 · 기기 id · 테마 등 설정 · 커서 몇 개.
 */
import { emit, EVENTS } from './bus.js';

const PREFIX = 'templum.';
let warned = false;

function key(k) { return k.startsWith(PREFIX) ? k : PREFIX + k; }

export function get(k, fallback = null) {
  try {
    const raw = localStorage.getItem(key(k));
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;                       // 깨진 값은 없는 것으로 친다
  }
}

export function set(k, value) {
  try {
    localStorage.setItem(key(k), JSON.stringify(value));
    return true;
  } catch (e) {
    const quota = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
    if (quota) {
      if (!warned) { warned = true; emit(EVENTS.STORAGE_FULL, { key: key(k), usage: usage() }); }
      console.warn('[kv] 저장 공간이 찼습니다 —', key(k));
    } else {
      console.warn('[kv] 저장 실패', key(k), e);
    }
    return false;
  }
}

export function del(k) {
  try { localStorage.removeItem(key(k)); } catch (e) { /* 무시 */ }
}

/** 대략적인 사용량(바이트) — 설정 화면 게이지용. */
export function usage() {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      n += (k.length + (localStorage.getItem(k) || '').length) * 2;   // UTF-16
    }
  } catch (e) { /* 무시 */ }
  return n;
}

/** 이 기기의 고유 이름 — 폰→PC 동기화에서 배치 파일을 기기별로 가른다. */
export function deviceId() {
  let id = get('deviceId');
  if (!id) {
    const uuid = (crypto.randomUUID ? crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(16).slice(2));
    id = 'phone-' + uuid.replace(/-/g, '').slice(0, 8);
    set('deviceId', id);
  }
  return id;
}
