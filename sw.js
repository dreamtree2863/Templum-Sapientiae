/* sw.js — 서비스워커: 오프라인 캐시 + Drive 인증 프록시.
 *
 *  ‼ DOC_CACHE 이름은 **이 파일만** 안다.
 *    옛 구조는 app.js:1330 에도 같은 문자열이 있어 한쪽만 고치면 조용히 어긋났다.
 *    앱은 이제 캐시 이름을 모르고, 재검증은 `?__mtime=` 질의로 부탁만 한다.
 *
 *  ‼ 그 부탁을 **헤더로 받으면 안 된다.** 비표준 헤더는 교차 출처에서 사전요청을
 *    부르는데 Drive 가 그 이름을 허용하지 않아, 문서 요청이 통째로 "Failed to fetch"
 *    가 된다. 질의로 받고 Drive 로 나가기 전에 떼어 낸다.
 *
 *  갈래
 *    · 셸(같은 출처 GET)      network-first → 실패 시 캐시
 *    · Drive 문서(alt=media)  mtime 이 같으면 **캐시 우선**(네트워크 0), 아니면 받아서 갱신
 *    · Drive 음성/Range       캐시하지 않고 Authorization 만 끼워 그대로 흘려보냄(206 유지)
 *    · 그 외                  건드리지 않음
 *
 *  버전 정책
 *    앱 갱신 = SHELL_CACHE 만 올린다. DOC_CACHE 는 *형식*이 바뀔 때만 —
 *    올리면 받아둔 문서 본문이 전부 날아가 다시 받는다.
 */

const SHELL_CACHE = 'templum-shell-v37';   // v36 검색 색인 · v37 증분이 _state 를 버리던 것 교정
const DOC_CACHE = 'templum-docs-v4';       // 형식 그대로 → 본문 재다운로드 없음
const MTIME_HEADER = 'x-doc-mtime';   // 캐시에 새겨 두는 이름표(응답 쪽). 요청은 질의로 받는다
const MTIME_PARAM = '__mtime';        // 앱이 붙여 보내는 질의 — Drive 로 나가기 전에 떼어 낸다

/* 워밍업 목록일 뿐이다 — 아래 fetch 처리기가 같은 출처 GET 을 런타임에 모두 캐시하므로
   여기 빠진 파일이 있어도 한 번 방문하면 오프라인에서 열린다. */
const SHELL_FILES = [
  './', './index.html', './manifest.webmanifest',
  './css/base.css', './css/shell.css', './css/list.css', './css/viewer.css',
  './js/main.js',
  './js/core/bus.js', './js/core/store.js', './js/core/router.js',
  './js/core/idb.js', './js/core/kv.js', './js/core/log.js',
  './js/data/index.js', './js/data/auth.js', './js/data/drive-api.js',
  './js/data/catalog.js', './js/data/classify.js',
  './js/data/doc-content.js', './js/data/doc-rules.js',
  './js/data/audio.js', './js/data/id3.js',
  './js/data/answers.js', './js/data/outbox.js',
  './js/data/drive-files.js', './js/data/uplink.js', './js/data/review.js', './js/data/mcq.js', './js/data/search.js', './js/data/searchindex.js',
  './js/features/shell.js', './js/features/home.js',
  './js/features/list/list.js', './js/features/list/browse.js',
  './js/features/viewer/viewer.js', './js/features/viewer/inject.js',
  './js/features/viewer/frame-bridge.js', './js/features/viewer/toolbar.js',
  './js/features/tts/player.js', './js/features/tts/normalize.js',
  './js/features/settings/settings.js', './js/features/update.js',
  './js/features/review/review.js', './js/features/mcq/mcq.js', './js/features/ai/ai.js',
  './vendor/tts_player.js',
  './vendor/mathjax/es5/tex-mml-chtml.js',
];

let swToken = null;      // 페이지가 준 Drive 토큰 — SW 메모리에만 머문다

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_FILES)).catch(() => {})
  );
  // skipWaiting 은 페이지가 명시로 요청할 때만 — 쓰는 중에 갈아치우지 않는다
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== DOC_CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  const d = event.data;
  if (d === 'skipWaiting') { self.skipWaiting(); return; }
  if (d && d.type === 'token' && d.token) swToken = d.token;
  // 지금 도는 셸이 몇 판인지 — 설정 화면에 띄워 "왜 새 기능이 안 보이지"를 없앤다
  if (d && d.type === 'version' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: SHELL_CACHE });
  }
});

/** <audio> 같은 직접 요청에는 인증 헤더가 없다 — 보관 토큰으로 채운다.
 *  Range 등 원래 헤더는 그대로 복사해 스트리밍·탐색을 유지한다. */
function withAuth(req) {
  if (req.headers.has('Authorization') || !swToken) return req;
  const h = new Headers(req.headers);
  h.set('Authorization', 'Bearer ' + swToken);
  return new Request(req.url, {
    method: req.method, headers: h,
    mode: 'cors', credentials: 'omit', redirect: 'follow',
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  const isDriveMedia = url.hostname === 'www.googleapis.com'
    && url.pathname.startsWith('/drive/v3/files/')
    && url.searchParams.get('alt') === 'media';

  if (isDriveMedia) {
    // 음성·영상 스트리밍 — 캐시하지 않고 Range 그대로 흘린다
    if (req.destination === 'audio' || req.destination === 'video' || req.headers.has('range')) {
      event.respondWith(
        fetch(withAuth(req), { cache: 'no-store' }).catch(() => new Response('', { status: 504 }))
      );
      return;
    }
    event.respondWith(handleDoc(req));
    return;
  }

  /* ‼ 같은 출처라도 **미디어·Range 요청은 건드리지 않는다.**
     가로채면 206(부분 응답)을 셸 캐시에 담게 되고, 그러면 오디오 탐색이 죽는다
     — 낭독에서 문단을 눌러도 그 자리로 안 간다(실제로 물렸던 회귀). */
  if (req.headers.has('range') || req.destination === 'audio' || req.destination === 'video') {
    return;
  }

  if (req.method === 'GET' && url.origin === self.location.origin) {
    /* ‼ `cache: 'no-cache'` — 브라우저 HTTP 캐시를 건너뛰고 서버에 되묻는다(ETag).
       이게 없으면 GitHub Pages 의 max-age 때문에 새 버전을 올려도 폰이 한참 동안
       옛 파일을 쓴다. 실제로 "설정 화면은 뜨는데 새 단추가 없다"로 나타났다.
       내용이 그대로면 304 라 데이터도 거의 안 든다. */
    event.respondWith(
      fetch(req, { cache: 'no-cache' }).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, clone)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
  }
  // 그 외(Drive 목록 API·OAuth)는 건드리지 않는다
});

/**
 * 문서 본문.
 *   앱이 X-Doc-Mtime 을 보내면 캐시에 담아 둔 같은 값과 견준다.
 *   같으면 네트워크에 나가지 않는다(폰 데이터·배터리·체감속도 모두 이득).
 */
async function handleDoc(req) {
  const cache = await caches.open(DOC_CACHE);

  /* ‼ mtime 은 질의(__mtime)로 온다 — 헤더로 받으면 Drive 의 CORS 가 사전요청을
     막아 요청 자체가 못 나간다("Failed to fetch"). 여기서 값을 빼내고 **떼어 낸 주소**로
     Drive 에 나간다. 캐시 키도 떼어 낸 주소라 판 갈이가 되지 않는다. */
  const u = new URL(req.url);
  const want = u.searchParams.get(MTIME_PARAM) || req.headers.get(MTIME_HEADER);
  u.searchParams.delete(MTIME_PARAM);
  const clean = u.toString();
  const key = new Request(clean, { method: 'GET' });     // 헤더를 뺀 URL 만 키로
  const upstream = new Request(clean, { method: 'GET', headers: req.headers });

  if (want) {
    const hit = await cache.match(key);
    if (hit && hit.headers.get(MTIME_HEADER) === want) return hit;
  }

  try {
    const resp = await fetch(withAuth(upstream), { cache: 'no-store' });
    if (resp.ok && resp.status === 200) {
      // mtime 을 응답에 새겨 둔다 — 다음에 견줄 기준
      const body = await resp.clone().blob();
      const h = new Headers(resp.headers);
      if (want) h.set(MTIME_HEADER, want);
      cache.put(key, new Response(body, { status: 200, headers: h })).catch(() => {});
    }
    return resp;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;                                  // 오프라인 — 받아둔 것으로
    throw err;
  }
}
