/* auth.js — Google OAuth (GSI) · 토큰 보관 · 서비스워커 전달.
 *
 *  ‼ 옛 app.js:88-184 를 옮긴 것. 로직은 그대로 두고 셋만 바꿨다.
 *    · alert() 제거 → bus 이벤트로 (데이터 층은 화면을 모른다)
 *    · onSignedIn() 직접 호출 → auth:changed 통지
 *    · 토큰에 **scope 를 함께 기록** — 4단계에서 쓰기 권한을 더할 때
 *      "지금 토큰이 어디까지 되는가"를 알아야 재동의를 걸 수 있다.
 *
 *  리프레시 토큰은 없다(브라우저 암묵 흐름). 1시간 만료 → 401 → silent 재인증.
 */
import * as kv from '../core/kv.js';
import { emit, EVENTS } from '../core/bus.js';
import { patch } from '../core/store.js';
import * as log from '../core/log.js';

const CLIENT_ID = '113629352800-he0vmc6f2m3f3vn5clr968db12sf6t4u.apps.googleusercontent.com';

/** 읽기 — 지금(1~3단계) 쓰는 전부. */
export const SCOPE_READ = 'https://www.googleapis.com/auth/drive.readonly';
/** 쓰기 — 4단계(폰→PC)에서 처음 켤 때만 더 요청한다. 앱이 만든 파일만 건드리는 비민감 스코프. */
export const SCOPE_WRITE = 'https://www.googleapis.com/auth/drive.file';

const TOKEN_KEY = 'auth.v2';          // {token, expiresAt, scopes[]}

let tokenClient = null;
let token = null;
let scopes = [];
let silentTried = false;

/* ── 토큰 보관 ─────────────────────────────────────────────────────── */
function store(tok, expiresIn, granted) {
  scopes = String(granted || SCOPE_READ).split(/\s+/).filter(Boolean);
  token = tok;
  kv.set(TOKEN_KEY, {
    token: tok,
    expiresAt: Date.now() + (Number(expiresIn) || 3600) * 1000,
    scopes,
  });
  patch('auth', { signedIn: true, scopes });
  postTokenToSW();
  emit(EVENTS.AUTH_CHANGED, { signedIn: true, scopes });
}

function loadStored() {
  const d = kv.get(TOKEN_KEY);
  if (!d || !d.token) return null;
  // 60초 여유로 만료 판정 — Drive 호출 도중 만료되는 것을 피한다
  if (d.expiresAt && d.expiresAt > Date.now() + 60_000) {
    scopes = d.scopes || [SCOPE_READ];
    return d.token;
  }
  return null;
}

export function clear() {
  kv.del(TOKEN_KEY);
  token = null;
  scopes = [];
  patch('auth', { signedIn: false, scopes: [] });
  emit(EVENTS.AUTH_CHANGED, { signedIn: false, scopes: [] });
}

export const getToken = () => token;
export const signedIn = () => !!token;
export const hasScope = (s) => scopes.includes(s);

/* ── 서비스워커에 토큰 전달 ─────────────────────────────────────────
 *  SW 가 <audio> 요청에 Authorization 을 끼워 넣어야 통째 다운로드 없이
 *  Range 스트리밍이 된다. 토큰은 SW 메모리에만 머문다. */
export function postTokenToSW() {
  try {
    const sw = navigator.serviceWorker;
    if (sw?.controller && token) sw.controller.postMessage({ type: 'token', token });
  } catch (e) { /* 무시 */ }
}

/* ── 로그인 흐름 ───────────────────────────────────────────────────── */

/** GSI 스크립트가 늦게 뜰 수 있어 잠깐씩 기다린다. 최대 6초. */
function waitForGsi(tries = 30) {
  return new Promise((resolve) => {
    const tick = () => {
      if (window.google?.accounts?.oauth2) return resolve(true);
      if (--tries <= 0) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
}

/**
 * 기동. 반환 {ok, offline} — offline 이면 GSI 를 못 받은 것이니
 * 호출 측은 **로그인 화면에 가두지 말고** 캐시된 목록으로 들여보내야 한다.
 * (지하철에서 앱이 먹통이 되던 원인이 바로 이 지점이었다.)
 */
export async function init({ scope = SCOPE_READ } = {}) {
  const cached = loadStored();
  if (cached) {
    token = cached;
    patch('auth', { signedIn: true, scopes });
    postTokenToSW();
    emit(EVENTS.AUTH_CHANGED, { signedIn: true, scopes });
  }

  const ok = await waitForGsi();
  if (!ok) {
    log.warn('auth', 'GSI 를 불러오지 못했습니다(오프라인?) — 캐시로 진행');
    return { ok: false, offline: true, signedIn: !!token };
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope,
    include_granted_scopes: true,      // 이미 받은 권한을 유지한 채 더한다
    callback: (resp) => {
      if (resp.error) {
        // silent 실패는 조용히 — 사용자가 직접 누르게 둔다
        if (!silentTried) emit(EVENTS.TOAST, { text: '로그인 실패: ' + resp.error, kind: 'error' });
        silentTried = false;
        return;
      }
      store(resp.access_token, resp.expires_in, resp.scope);
    },
  });

  if (!token) await trySilent();
  return { ok: true, offline: false, signedIn: !!token };
}

/** 구글에 이미 로그인돼 있으면 동의 화면 없이 토큰을 받는다. */
export function trySilent() {
  if (!tokenClient) return Promise.resolve(false);
  silentTried = true;
  try { tokenClient.requestAccessToken({ prompt: '' }); } catch (e) { silentTried = false; }
  return Promise.resolve(true);
}

/** 사용자가 버튼을 눌렀을 때 — 동의 화면을 띄운다. */
export function signIn({ scope } = {}) {
  if (!tokenClient) {
    emit(EVENTS.TOAST, { text: '로그인 준비가 안 됐습니다. 연결을 확인해 주세요.', kind: 'error' });
    return;
  }
  silentTried = false;
  const opts = { prompt: 'consent' };
  if (scope) opts.scope = scope;
  tokenClient.requestAccessToken(opts);
}

/** 401 을 받았을 때 drive-api 가 부른다. */
export function onUnauthorized() {
  log.warn('auth', '토큰 만료 — 재인증 시도');
  kv.del(TOKEN_KEY);
  token = null;
  patch('auth', { signedIn: false, scopes: [] });
  trySilent();
}

/** 4단계에서 쓰기 권한이 필요해질 때. */
export function ensureWriteScope() {
  if (hasScope(SCOPE_WRITE)) return true;
  signIn({ scope: SCOPE_READ + ' ' + SCOPE_WRITE });
  return false;
}
