// ─────────────────────────────────────────────────────────────────────
// Service Worker — 온디맨드 캐시
//   · PWA 셸 (index.html, app.js, style.css, manifest) 은 *항상 캐시*
//   · Drive API 의 파일 다운로드 응답은 *열어본 것만 캐시* (on-demand)
//   · 캐시 적중 시 즉시 반환 (오프라인 OK), 없으면 네트워크 → 캐시
// ─────────────────────────────────────────────────────────────────────

const SHELL_CACHE = "templum-shell-v1";
const DOC_CACHE = "templum-docs-v1";

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
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k !== SHELL_CACHE && k !== DOC_CACHE).map(k => caches.delete(k))
        ))
    );
    self.clients.claim();
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

    // PWA 셸 — cache first
    if (req.method === "GET" && url.origin === self.location.origin) {
        event.respondWith(
            caches.match(req).then(hit => hit || fetch(req).then(resp => {
                if (resp.ok) {
                    const clone = resp.clone();
                    caches.open(SHELL_CACHE).then(c => c.put(req, clone)).catch(() => {});
                }
                return resp;
            }))
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
