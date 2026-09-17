/* store.js — "지금 무엇이 있는가". 프레임워크 없는 40줄짜리 단일 상태.
 *
 *  ‼ 단방향을 만드는 규칙은 하나뿐이다:
 *      patch()  는 데이터 층만 부른다
 *      subscribe() 는 화면 층만 부른다
 *    화면이 patch 를 부르기 시작하면 이 구조는 의미를 잃는다.
 *    화면이 무언가를 바꿔야 할 땐 data/index.js 가 내보낸 함수를 부른다.
 */

const state = {
  auth: { signedIn: false, scopes: [], email: '' },
  catalog: { files: [], groups: {}, tree: {}, fetchedAt: 0, loading: false, total: 0 },
  doc: { id: null, title: '', path: '', prefix: null },
  outbox: { pending: 0, lastPushAt: 0 },
  search: { indexed: 0, at: 0 },        // 검색 색인 — 본문·태그까지 보는 판
  review: { due: 0, session: [] },
  ui: { route: '#/', theme: 'system', textScale: 1, online: navigator.onLine },
};

const subs = new Map();   // key → Set<fn>

/** 읽기 — 언제든 누구나. 돌려주는 것은 살아 있는 참조이니 고치지 말 것. */
export function get(key) {
  return key ? state[key] : state;
}

/** 쓰기 — 데이터 층 전용. 바뀐 조각만 넘긴다. */
export function patch(key, partial) {
  const prev = state[key];
  const next = { ...prev, ...partial };
  // 값이 그대로면 알리지 않는다 (불필요한 재렌더 방지)
  let same = true;
  for (const k in partial) { if (prev[k] !== next[k]) { same = false; break; } }
  if (same) return next;
  state[key] = next;
  const set = subs.get(key);
  if (set) for (const fn of [...set]) {
    try { fn(next, prev); } catch (e) { console.error('[store]', key, e); }
  }
  return next;
}

/** 구독 — 화면 층 전용. 해제 함수를 돌려준다. */
export function subscribe(key, fn, { immediate = false } = {}) {
  if (!subs.has(key)) subs.set(key, new Set());
  subs.get(key).add(fn);
  if (immediate) { try { fn(state[key], state[key]); } catch (e) { console.error(e); } }
  return () => subs.get(key)?.delete(fn);
}
