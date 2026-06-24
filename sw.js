// ─────────────────────────────────────────────────────────────────────
// Service Worker — 온디맨드 캐시 + Drive 인증 프록시
//   · PWA 셸 (index.html, app.js, style.css, manifest) 은 network-first
//   · Drive 문서(HTML) alt=media 는 network-first(no-store) → 열어본 것만 캐시(오프라인용)
//   · Drive 음성(mp3 등) 은 <audio> 가 직접 스트리밍 — SW 가 Authorization 헤더를
//     주입하고 Range 요청을 그대로 전달(206) → 통째 다운로드 없이 즉시 재생/탐색
//   · 모든 Drive fetch 는 cache:'no-store' → 브라우저 HTTP 캐시가 옛 내용을 주지 못함
// ─────────────────────────────────────────────────────────────────────

// 버전 정책: 앱(코드) 갱신 때는 SHELL_CACHE 만 bump 한다(셸=index/app.js/style 만 다시 받음).
//   DOC_CACHE 는 *문서 캐시 형식이 바뀔 때만* 올린다 — 올리면 받아둔 문서 본문이 전부
//   날아가 재다운로드된다. 그래서 앱 갱신만으로는 절대 올리지 않는다(전체 재로드 방지).
const SHELL_CACHE = "templum-shell-v15";  // v15: 증분 새로고침(버튼/당겨서) + Drive 500 재시도
const DOC_CACHE = "templum-docs-v4";      // (문서 캐시 형식 그대로 유지 → 본문 재다운로드 없음)

const SHELL_FILES = [
    "./",
    "./index.html",
    "./app.js",
    "./style.css",
    "./manifest.webmanifest",
];

// 페이지가 보내준 Drive 액세스 토큰(메모리에만 보관). <audio> 직접요청에 헤더 주입용.
let swToken = null;

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_FILES)).catch(() => {})
    );
    // skipWaiting 은 페이지가 토스트로 명시 요청할 때만
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k !== SHELL_CACHE && k !== DOC_CACHE).map(k => caches.delete(k))
        ))
    );
    self.clients.claim();
});

self.addEventListener('message', event => {
    const d = event.data;
    if (d === 'skipWaiting') { self.skipWaiting(); return; }
    if (d && d.type === 'token' && d.token) { swToken = d.token; }
});

// 인증 헤더가 없으면(예: <audio> 의 직접요청) 보관 토큰으로 채워 새 Request 생성.
// Range 등 원래 헤더는 그대로 복사 → 스트리밍/탐색 유지.
function withAuth(req) {
    if (req.headers.has('Authorization') || !swToken) return req;
    const h = new Headers(req.headers);
    h.set('Authorization', 'Bearer ' + swToken);
    return new Request(req.url, {
        method: req.method,
        headers: h,
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
    });
}

self.addEventListener('fetch', event => {
    const req = event.request;
    const url = new URL(req.url);

    // Drive 파일 다운로드 — alt=media GET
    if (url.hostname === "www.googleapis.com"
        && url.pathname.startsWith("/drive/v3/files/")
        && url.searchParams.get("alt") === "media") {
        // 음성(미디어) — <audio> 스트리밍: 캐시하지 않고 Range 그대로 전달, 인증 주입
        if (req.destination === "audio" || req.destination === "video" || req.headers.has("range")) {
            event.respondWith(
                fetch(withAuth(req), { cache: 'no-store' })
                    .catch(() => new Response("", { status: 504 }))
            );
            return;
        }
        // 문서(HTML) — network-first(no-store) + 열어본 것 캐시
        event.respondWith(handleDocFetch(req));
        return;
    }

    // PWA 셸 — network-first
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
    // 그 외(Drive listing API, OAuth 등) — 항상 네트워크
});

async function handleDocFetch(req) {
    const cache = await caches.open(DOC_CACHE);
    try {
        // no-store: 브라우저 HTTP 캐시 우회 → 항상 Drive 의 최신 내용
        const resp = await fetch(withAuth(req), { cache: 'no-store' });
        if (resp.ok && resp.status === 200) {
            cache.put(req, resp.clone()).catch(() => {});
        }
        return resp;
    } catch (err) {
        const hit = await cache.match(req);
        if (hit) return hit;
        throw err;
    }
}
