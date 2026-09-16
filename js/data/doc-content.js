/* doc-content.js — 문서 본문을 받아 온다.
 *
 *  ‼ 본문을 **JS 문자열로 만들지 않는다.**
 *    백지인출 최대 문서가 5.17MB 다. `.text()` 를 부르면 UTF-8 5MB 가
 *    10MB JS 문자열이 되고, srcdoc 에 넣으면 또 복사된다.
 *    여기서는 Blob 으로 받아 URL.createObjectURL 로 iframe 에 건넨다 —
 *    본문이 힙에 올라오는 일이 없다.
 *
 *  ‼ 캐시 이름은 여기서 모른다. sw.js 가 단독으로 안다.
 *    우리는 X-Doc-Mtime 헤더로 "이 버전이면 받아둔 걸 주세요"라고 부탁만 한다.
 */
import { HEAD_BYTES, prefixOf } from './doc-rules.js';
import * as log from '../core/log.js';

const MEDIA = 'https://www.googleapis.com/drive/v3/files/';

/* ‼ mtime 을 **헤더로 보내면 문서가 하나도 안 열린다.**
 *   `X-Doc-Mtime` 같은 비표준 헤더는 교차 출처에서 사전요청(preflight)을 부르는데,
 *   Drive 의 Access-Control-Allow-Headers 에 그 이름이 없다 → 요청이 아예 못 나가고
 *   "Failed to fetch". (실측: Authorization·Range 는 통과, X-Doc-Mtime 만 막힘.
 *    로컬 시험은 같은 출처라 이 경로를 한 번도 지나지 않아 드러나지 않았다.)
 *
 *   그래서 질의로 싣는다. 질의는 사전요청을 부르지 않고, 서비스워커가 이 값을 읽은 뒤
 *   **떼어 내고** Drive 로 보내므로 Drive 는 이런 것이 있는 줄도 모른다.
 *   서비스워커가 없을 때는 아예 붙이지 않는다(그때는 재검증도 의미가 없다). */
const MTIME_PARAM = '__mtime';

let _getToken = () => null;
export function configure({ getToken }) { if (getToken) _getToken = getToken; }

/**
 * 문서 하나를 받아 온다. 반환:
 *   { blob, head, tail, prefix, fromCache }
 *   head  앞 400KB 문자열 — 무엇을 넣어 줄지 판정하는 데만 쓴다
 *   tail  뒤 20KB 문자열 — 문서의 PREFIX(답 저장 이름표)를 캐는 데만 쓴다
 */
export async function fetchDoc(file, { signal } = {}) {
  const swOn = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  const url = MEDIA + encodeURIComponent(file.id) + '?alt=media'
    + (swOn && file.mtime ? '&' + MTIME_PARAM + '=' + encodeURIComponent(file.mtime) : '');
  const headers = { Authorization: 'Bearer ' + _getToken() };

  const resp = await fetch(url, { headers, signal });
  if (resp.status === 401) throw new Error('로그인이 필요합니다.');
  if (!resp.ok) throw new Error('문서를 받지 못했습니다 (' + resp.status + ')');

  const blob = await resp.blob();
  const head = await blob.slice(0, HEAD_BYTES).text();
  const tail = blob.size > HEAD_BYTES
    ? await blob.slice(Math.max(0, blob.size - 20_000)).text()
    : head;

  return {
    blob,
    head,
    tail,
    prefix: prefixOf(tail) || prefixOf(head),
    fromCache: resp.headers.has('x-doc-mtime'),
    size: blob.size,
  };
}

/** 아주 드문 폴백 — 문자열 수술이 필요한 문서(수식칸 있는 1편)만. */
export async function textOf(blob) {
  return blob.text();
}

/** 받아 둔 문서가 너무 쌓이지 않게. 문서 총량이 247MB 라 상한이 필요하다. */
export async function trimCache({ maxBytes = 120 * 1024 * 1024, keep = 60 } = {}) {
  try {
    const names = await caches.keys();
    const docCache = names.find(n => n.startsWith('templum-docs'));
    if (!docCache) return { removed: 0 };
    const cache = await caches.open(docCache);
    const reqs = await cache.keys();
    if (reqs.length <= keep) return { removed: 0 };
    // Cache Storage 는 순서를 보장하지 않으니 넣은 순서(대략)로 앞쪽부터 버린다
    let removed = 0;
    for (const r of reqs.slice(0, reqs.length - keep)) {
      await cache.delete(r);
      removed++;
    }
    log.info('doc', `받아둔 문서 ${removed}개 정리`);
    return { removed };
  } catch (e) {
    log.warn('doc', '캐시 정리 실패', e);
    return { removed: 0 };
  }
}
