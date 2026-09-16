/* index.js — 데이터 층의 **유일한 공개 창구**.
 *
 *  화면 층(js/features/**)은 오직 이 파일에서만 가져다 쓴다.
 *      import { catalog, auth } from '../../data/index.js';
 *
 *  화면이 drive-api.js 를 직접 부르기 시작하면 층이 무너지므로,
 *  tools/check-layers.sh 가 그런 import 를 잡아낸다.
 *
 *  화면이 **데이터를 바꿔야** 할 땐 여기 있는 async 함수를 부른다.
 *  화면이 store.patch() 를 직접 부르는 일은 없다 — 그게 단방향을 만드는 유일한 규칙.
 */
import * as auth from './auth.js';
import * as catalog from './catalog.js';
import * as classify from './classify.js';
import * as driveApi from './drive-api.js';
import * as docContent from './doc-content.js';
import * as docRules from './doc-rules.js';
import * as idb from '../core/idb.js';
import * as kv from '../core/kv.js';
import * as log from '../core/log.js';

export { auth, catalog, classify, docContent, docRules, log };

/** 앱이 처음 뜰 때 한 번. 반환 {signedIn, offline, cached} */
export async function boot() {
  driveApi.configure({
    getToken: auth.getToken,
    onUnauthorized: auth.onUnauthorized,
  });
  docContent.configure({ getToken: auth.getToken });
  const cached = await catalog.load();          // 캐시를 먼저 보여 준다(체감 속도)
  const a = await auth.init();
  idb.requestPersist();                          // 캐시가 함부로 비워지지 않게 요청
  return { signedIn: a.signedIn, offline: a.offline, cached };
}

/** 목록 새로고침 — 버튼·당겨서 새로고침이 부른다. */
export function refresh(opts) { return catalog.refresh(opts); }

/** 문서 하나를 최근 본 것으로 기록 — 홈·목록 맨 위에 띄우는 근거. */
export async function markOpened(file) {
  try {
    const recents = (await idb.get('state', 'recents')) || [];
    const next = [{ id: file.id, name: file.name, path: file.path, at: Date.now() }]
      .concat(recents.filter(r => r.id !== file.id)).slice(0, 30);
    await idb.put('state', 'recents', next);
  } catch (e) { log.warn('data', '최근 문서 기록 실패', e); }
}

export async function recents(n = 10) {
  const r = (await idb.get('state', 'recents')) || [];
  return r.slice(0, n);
}

/** 풀다 만 학습지 — 스크롤 위치가 남아 있는 것들. */
export async function inProgress(n = 5) {
  const all = await idb.all('docPos').catch(() => []);
  return (all || []).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, n);
}

/** 저장 공간 현황 — 설정 화면. */
export async function storageInfo() {
  return { local: kv.usage(), idb: await idb.estimate() };
}
