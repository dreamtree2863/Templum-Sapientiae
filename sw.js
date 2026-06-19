// ─────────────────────────────────────────────────────────────────────
// Service Worker — 온디맨드 캐시
//   · PWA 셸 (index.html, app.js, style.css, manifest) 은 *항상 캐시*
//   · Drive API 의 파일 다운로드 응답은 *열어본 것만 캐시* (on-demand)
//   · 캐시 적중 시 즉시 반환 (오프라인 OK), 없으면 네트워크 → 캐시
// ─────────────────────────────────────────────────────────────────────

// 버전 — 셸 파일 갱신 시 bump (예: -v2, -v3 …)
const SHELL_CACHE = "templum-shell-v8";  // v8: 낭독 오디오 연결 강제 재조회(docList v7) — 셸 갱신
const DOC_CACHE = "templum-docs-v3";     // v3: 문서 캐시 초기화 — 수정/신규 문서 즉시 픽업

const SHELL_FILES = [
    "./",
    "./index.html",
    "./app.js",
    "./style.css",
    "./manifest.webmanifest",
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_FILES)).catch(() => {})
    );
    // skipWaiting 은 페이지가 명시적으로 메시지 보낼 때만 — 사용자가 토스트 누르기 전까진 옛 버전 유지
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k !== SHELL_CACHE && k !== DOC_CACHE).map(k => caches.delete(k))
        ))
    );
    self.clients.claim();
});

// 페이지에서 'skipWaiting' 메시지 받으면 즉시 활성화 — 토스트 클릭 시 호출됨
self.addEventListener('message', event => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});

self.addEventListener('fetch', event => {
    const req = event.request;
    const url = new URL(req.url);

    // Drive 파일 다운로드 — alt=media 가 붙은 GET. 토큰은 헤더에 있어 cache key 가 안전.
    if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/drive/v3/files/")
        && url.searchParams.get("alt") === "media") {
        event.respondWith(handleDocFetch(req));
        return;
    }

    // PWA 셸 — *network-first* 로 변경: 항상 최신 시도, 실패 시 캐시.
    // 이렇게 해야 새 버전 푸시가 다음 접속 시 즉시 반영됨.
    if (req.method === "GET" && url.origin === self.location.origin) {
        event.respondWith(
            fetch(req).then(resp => {
                if (resp.ok) {
                    const clone = resp.clone();
                    caches.open(SHELL_CACHE).then(c => c.put(req, clone)).catch(() => {});
                }
                return resp;
            }).catch(() => caches.match(req))
        );
        return;
    }
    // 그 외 (Drive listing API, OAuth 등) — 항상 네트워크
});

async function handleDocFetch(req) {
    // 캐시 키는 URL 의 *경로 + alt=media* 만 사용 (토큰은 헤더에 있어 URL 에 없음)
    const cache = await caches.open(DOC_CACHE);
    // 네트워크 우선 시도 — 새 버전 픽업. 실패하면 캐시 반환 (오프라인).
    try {
        const resp = await fetch(req);
        if (resp.ok) {
            cache.put(req, resp.clone()).catch(() => {});
        }
        return resp;
    } catch (err) {
        const hit = await cache.match(req);
        if (hit) return hit;
        throw err;
    }
}
