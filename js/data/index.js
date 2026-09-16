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
import * as audio from './audio.js';
import * as answers from './answers.js';
import * as outbox from './outbox.js';
import * as driveFiles from './drive-files.js';
import * as uplink from './uplink.js';
import * as idb from '../core/idb.js';
import * as kv from '../core/kv.js';
import * as log from '../core/log.js';

export { auth, catalog, classify, docContent, docRules, audio, answers, outbox, uplink, log };

/** 앱이 처음 뜰 때 한 번. 반환 {signedIn, offline, cached} */
export async function boot() {
  driveApi.configure({
    getToken: auth.getToken,
    onUnauthorized: auth.onUnauthorized,
  });
  docContent.configure({ getToken: auth.getToken });
  audio.configure({ getToken: auth.getToken });
  driveFiles.configure({ getToken: auth.getToken });
  const cached = await catalog.load();          // 캐시를 먼저 보여 준다(체감 속도)
  const a = await auth.init();
  idb.requestPersist();                          // 캐시가 함부로 비워지지 않게 요청
  await outbox.publish();                        // 보낼 것이 몇 건인지 홈에 바로 뜨게
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

/**
 * 학습지 답안을 거둬 큐에 넣는다 — 바뀐 게 있을 때만.
 *
 * ‼ 폰은 언제든 죽는다. 그래서 문서를 닫을 때만이 아니라 화면이 가려질 때도 부른다.
 *   그 말은 **여러 번 겹쳐 불린다**는 뜻이다. 지문 확인이 IndexedDB 왕복을 기다리는
 *   사이 다음 호출이 끼어들면 둘 다 "바뀌었다"고 보고 같은 답이 여러 건 쌓인다
 *   (실측: 2건이어야 할 것이 5건). 그래서 문서마다 **줄을 세우고**, 지문은
 *   메모리에도 들고 있는다.
 */
const capturing = new Map();      // docId → 진행 중인 약속(줄 세우기)
const lastSig = new Map();        // docId → 마지막으로 보낸 지문

export function captureAnswers(file, prefix) {
  if (!file || !prefix) return Promise.resolve(null);
  const prev = capturing.get(file.id) || Promise.resolve(null);
  const next = prev.catch(() => null).then(() => doCapture(file, prefix));
  capturing.set(file.id, next);
  next.finally(() => { if (capturing.get(file.id) === next) capturing.delete(file.id); });
  return next;
}

async function doCapture(file, prefix) {
  const values = answers.collect(prefix);
  if (!Object.keys(values).length) return null;
  const sig = answers.signature(values);
  if (lastSig.get(file.id) === sig) return null;
  const was = await idb.get('answerSig', file.id).catch(() => null);
  if (was && was.sig === sig) { lastSig.set(file.id, sig); return null; }
  lastSig.set(file.id, sig);                     // 먼저 새겨 둔다 — 뒤따라온 호출이 멈추도록
  const id = await outbox.enqueue(answers.event(file, prefix, values));
  await idb.put('answerSig', file.id, { sig, at: Date.now() }).catch(() => {});
  return id;
}
