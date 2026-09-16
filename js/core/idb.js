/* idb.js — IndexedDB 얇은 래퍼 (라이브러리 없이).
 *
 *  ‼ 왜 localStorage 가 아닌가
 *    아카이브 파일이 9,335개다. 목록을 통째로 localStorage 에 넣던 옛 구조는
 *    5MB 한도에 걸려 저장이 **조용히** 실패하고 있었다(app.js:245).
 *    IndexedDB 는 한도가 훨씬 크고 비동기라 메인 스레드를 막지도 않는다.
 *
 *  스토어
 *    catalog    파일 목록·폴더맵·메타      (key: 'files' | 'folderMap' | 'meta')
 *    outbox     폰→PC 로 보낼 이벤트 큐     (keyPath 'id', index 'ts')
 *    docPos     문서별 스크롤 위치          (key: fileId)
 *    answerSig  문서별 답안 지문(변경 감지)  (key: prefix)
 *    state      _state/*.json 로컬 사본     (key: 'review' | 'mcqHistory' | …)
 */

const DB_NAME = 'templum';
const DB_VERSION = 1;
const STORES = ['catalog', 'outbox', 'docPos', 'answerSig', 'state'];

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        if (name === 'outbox') {
          const os = db.createObjectStore('outbox', { keyPath: 'id' });
          os.createIndex('ts', 'ts');
        } else {
          db.createObjectStore(name);            // 바깥에서 키를 준다
        }
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function run(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const get = (store, key) => run(store, 'readonly', s => s.get(key));
export const put = (store, key, value) =>
  run(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const clear = (store) => run(store, 'readwrite', s => s.clear());
export const all = (store) => run(store, 'readonly', s => s.getAll());
export const count = (store) => run(store, 'readonly', s => s.count());

/** outbox 전용 — ts 오름차순(보낸 순서 보존). */
export function outboxByTime() {
  return open().then(db => new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction('outbox', 'readonly');
    const req = tx.objectStore('outbox').index('ts').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) { out.push(c.value); c.continue(); } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  }));
}

/** 브라우저가 알려 주는 저장 용량 — 설정 화면 게이지용. */
export async function estimate() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch (e) { return null; }
}

/** 브라우저가 캐시를 함부로 비우지 않도록 요청(거절돼도 무해). */
export async function requestPersist() {
  try { return await navigator.storage?.persist?.() ?? false; } catch (e) { return false; }
}
