/* auth.js — Google OAuth (GSI) · 토큰 보관 · 서비스워커 전달.
 *
 *  ‼ 옛 app.js:88-184 를 옮긴 것. 로직은 그대로 두고 셋만 바꿨다.
 *    · alert() 제거 → bus 이벤트로 (데이터 층은 화면을 모른다)
 *    · onSignedIn() 직접 호출 → auth:changed 통지
 *    · 토큰에 **scope 를 함께 기록** — 4단계에서 쓰기 권한을 더할 때
 *      "지금 토큰이 어디까지 되는가"를 알아야 재동의를 걸 수 있다.
 *
 *  리프레시 토큰은 없다(브라우저 암묵 흐름). 토큰은 1시간이면 만료된다.
 *
 *  ‼ '조용한' 재인증(prompt:'')도 실제로는 팝업을 연다. 설치형 PWA(안드로이드)는
 *    **사용자 터치 없이 연 팝업을 막는다** → 401·재실행 때의 자동 재인증이 실패하고
 *    로그아웃된 것처럼 보였다(2026-10-01). 그래서:
 *    · 재인증은 **터치 순간에** 한다 — 토큰이 없거나 10분 안에 만료되면 다음 터치에서 갱신.
 *    · 한 번 로그인한 적이 있으면(auth.ever) 만료돼도 '로그아웃'이 아니라 '갱신 대기'로 본다.
 *    · 계정 힌트(login_hint)로 계정 선택 창 없이 갱신한다.
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
const EVER_KEY = 'auth.ever';         // 한 번이라도 로그인했는가 — 만료 ≠ 로그아웃
const EMAIL_KEY = 'auth.email';       // login_hint 용 계정 주소
const RENEW_AHEAD_MS = 10 * 60_000;   // 만료 10분 전부터 다음 터치에서 미리 갱신

let tokenClient = null;
let token = null;
let expiresAt = 0;
let scopes = [];
let silentTried = false;
let renewing = false;

/* ── 토큰 보관 ─────────────────────────────────────────────────────── */
function store(tok, expiresIn, granted) {
  scopes = String(granted || SCOPE_READ).split(/\s+/).filter(Boolean);
  token = tok;
  expiresAt = Date.now() + (Number(expiresIn) || 3600) * 1000;
  kv.set(TOKEN_KEY, { token: tok, expiresAt, scopes });
  kv.set(EVER_KEY, true);
  renewing = false;
  writeWanted = false;
  patch('auth', { signedIn: true, scopes });
  postTokenToSW();
  emit(EVENTS.AUTH_CHANGED, { signedIn: true, scopes });
  if (!kv.get(EMAIL_KEY)) rememberEmail(tok);
  syncBrokerFromDrive(tok);   // 내 Drive 의 templum_broker.json → 중계 자동 설정·키 교체 반영
}

/** 내 Drive 최상위의 templum_broker.json({url,key}) — Apps Script setup() 이 쓴다.
 *  앱 로그인 토큰(drive.readonly)으로 읽어 중계를 스스로 설정한다. 폰에서 입력할 것이 없고,
 *  키를 바꾸면 다음 로그인 때 따라온다. 본인 계정으로만 읽히므로 공개 저장소와 무관하다.
 *  (설치형 PWA 와 크롬 탭의 저장 공간이 분리된 기기가 있어, 링크·QR 방식으로는 앱에 안 들어갔다) */
const BROKER_FILE = 'templum_broker.json';
async function syncBrokerFromDrive(tok) {
  try {
    const q = encodeURIComponent(`name='${BROKER_FILE}' and trashed=false`);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=1&fields=files(id)`,
      { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' });
    const f = r.ok ? ((await r.json()).files || [])[0] : null;
    if (!f) return;
    const r2 = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
      { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' });
    const c = r2.ok ? await r2.json().catch(() => null) : null;
    if (!c || !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(c.url || '') || !c.key) return;
    const cur = brokerCfg();
    if (cur && cur.url === c.url && cur.key === c.key && !brokerBad) return;
    saveBrokerCfg(c.url, c.key);
    await refreshBroker();
    emit(EVENTS.TOAST, { text: cur ? '토큰 중계 키를 새로 받았습니다' : '토큰 중계를 자동으로 설정했습니다 — 1시간 제한이 풀립니다', kind: 'ok' });
  } catch (e) { /* 파일이 없거나 오프라인 — 다음 로그인 때 다시 */ }
}

/* ── 토큰 중계(Google Apps Script, 2026-10-01) — 1시간 제한 해제 ─────────
 *  소유자 계정으로 도는 웹 앱이 **읽기 전용** 토큰을 팝업 없이 준다
 *  (설정 › 동기화에서 주소·키 입력. 주소·키는 이 기기에만 — 저장소에 올리지 않는다).
 *  · 읽기(목록·문서·낭독)는 이 토큰. 만료 10분 전에 미리 다시 받는다(호출이 ~5초).
 *  · 쓰기(폰→PC 기록)는 앱 로그인(drive.file). 보낼 것이 있을 때만 터치로 갱신(writeWanted).
 *  · SW 도 주소·키를 받아 두어, 화면이 꺼진 채 만료돼도 낭독 스트리밍을 스스로 이어 간다. */
const BROKER_KEY = 'auth.broker';      // {url, key}
const BROKER_TOK = 'auth.brokerTok';   // {t, exp}
let brokerTok = '';
let brokerExp = 0;
let brokerTimer = null;
let brokerBusy = null;
let writeWanted = false;
let brokerBad = false;   // 중계가 키를 거절(키 교체됨) → 다음 터치에서 로그인 갱신 → Drive 설정 파일에서 새 키

export const brokerCfg = () => { const b = kv.get(BROKER_KEY); return (b && b.url && b.key) ? b : null; };
const brokerFresh = () => !!brokerTok && Date.now() < brokerExp;
export function brokerStatus() {
  return { configured: !!brokerCfg(), fresh: brokerFresh(),
    minutesLeft: brokerFresh() ? Math.max(1, Math.round((brokerExp - Date.now()) / 60_000)) : 0,
    error: kv.get('auth.brokerErr') || '', url: brokerCfg()?.url || '', writeWanted };
}
function restoreBroker() {
  const b = kv.get(BROKER_TOK);
  if (b && b.t && b.exp > Date.now() + 60_000) { brokerTok = b.t; brokerExp = b.exp; }
}
export function refreshBroker() {
  const cfg = brokerCfg();
  if (!cfg) return Promise.reject(new Error('토큰 중계 미설정'));
  if (brokerBusy) return brokerBusy;
  brokerBusy = (async () => {
    try {
      const r = await fetch(`${cfg.url}?key=${encodeURIComponent(cfg.key)}&app=study`, { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!d.token) throw new Error(d.error === 'forbidden' ? '키가 맞지 않습니다' : (d.error || '중계 응답 ' + r.status));
      brokerTok = d.token;
      brokerExp = Date.now() + (Number(d.expires_in) || 3000) * 1000 - 60_000;
      brokerBad = false;
      kv.set(BROKER_TOK, { t: brokerTok, exp: brokerExp });
      kv.set('auth.brokerErr', '');
      patch('auth', { signedIn: true });
      postTokenToSW();
      emit(EVENTS.AUTH_CHANGED, { signedIn: true, scopes });
      scheduleBroker();
      return brokerTok;
    } catch (e) {
      kv.set('auth.brokerErr', String(e.message || e));
      if (/키가 맞지 않/.test(e.message || '')) brokerBad = true;
      scheduleBroker(60_000);
      throw e;
    } finally { brokerBusy = null; }
  })();
  return brokerBusy;
}
function scheduleBroker(ms) {
  clearTimeout(brokerTimer);
  if (!brokerCfg()) return;
  const wait = ms ?? Math.max(30_000, brokerExp - Date.now() - RENEW_AHEAD_MS);
  brokerTimer = setTimeout(() => refreshBroker().catch(() => {}), wait);
}
/** 설정 링크로 받은 값 저장만(기동 전) — 시험은 init 이 토큰을 받으며 한다. */
export function saveBrokerCfg(url, key) {
  kv.set(BROKER_KEY, { url, key });
  kv.del(BROKER_TOK);
  brokerTok = ''; brokerExp = 0;
}
/** 설정 화면에서 저장 — 바로 시험해 결과를 돌려준다. */
export function setBroker(url, key) {
  kv.set(BROKER_KEY, { url, key });
  brokerTok = ''; brokerExp = 0;
  return refreshBroker();
}
export function clearBroker() {
  kv.del(BROKER_KEY); kv.del(BROKER_TOK); kv.del('auth.brokerErr');
  brokerTok = ''; brokerExp = 0; clearTimeout(brokerTimer);
  postTokenToSW();
}
/** 보낼 기록이 있는데 쓰기 로그인이 만료 — 다음 터치에서 갱신하도록 표시하고 알린다. */
export function wantWrite() {
  if (writeWanted) return;
  writeWanted = true;
  emit(EVENTS.AUTH_CHANGED, { signedIn: !!getToken(), scopes, renewable: wasSignedIn() });
}

/** 계정 주소를 한 번 받아 둔다 — 다음 갱신부터 계정 선택 창 없이 넘어가게. */
async function rememberEmail(tok) {
  try {
    const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
      { headers: { Authorization: 'Bearer ' + tok } });
    const email = r.ok ? (await r.json())?.user?.emailAddress : '';
    if (email) { kv.set(EMAIL_KEY, email); patch('auth', { email }); }
  } catch (e) { /* 힌트는 없어도 동작한다 */ }
}

function withHint(opts) {
  const email = kv.get(EMAIL_KEY);
  return email ? { ...opts, login_hint: email } : opts;
}

/** 로그인한 적은 있는데 지금 쓸 토큰이 없다 = 터치 한 번으로 이어 붙일 수 있는 상태. */
export const wasSignedIn = () => !!kv.get(EVER_KEY);
// 중계가 있으면 앱 로그인은 '보낼 것'이 있을 때만 갱신한다(1시간마다 팝업을 띄우지 않게)
export const needsRenew = () => wasSignedIn() && (!token || expiresAt - Date.now() < RENEW_AHEAD_MS)
  && (!brokerCfg() || writeWanted || brokerBad);

/** 터치 순간에 부른다(팝업 허용). 토큰이 없거나 곧 만료되면 조용히 갱신. */
export function renew() {
  if (!tokenClient || renewing || !needsRenew()) return false;
  renewing = true;
  silentTried = true;
  try { tokenClient.requestAccessToken(withHint({ prompt: '' })); }
  catch (e) { renewing = false; silentTried = false; return false; }
  return true;
}

/** 화면 어디든 처음 누르는 순간 갱신을 건다 — capture 단계라 다른 처리보다 먼저. */
function armGestureRenew() {
  const onTouch = () => { if (navigator.onLine) renew(); };
  document.addEventListener('pointerdown', onTouch, true);
  document.addEventListener('keydown', onTouch, true);
}

function loadStored() {
  const d = kv.get(TOKEN_KEY);
  if (!d || !d.token) return null;
  // 받은 권한은 만료돼도 기억한다 — 쓰기 동의를 또 묻지 않게(갱신은 prompt:'' 로 된다)
  scopes = d.scopes || [SCOPE_READ];
  // 60초 여유로 만료 판정 — Drive 호출 도중 만료되는 것을 피한다
  if (d.expiresAt && d.expiresAt > Date.now() + 60_000) {
    expiresAt = d.expiresAt;
    return d.token;
  }
  return null;
}

export function clear() {
  kv.del(TOKEN_KEY);
  kv.del(EVER_KEY);
  token = null;
  expiresAt = 0;
  scopes = [];
  patch('auth', { signedIn: false, scopes: [] });
  emit(EVENTS.AUTH_CHANGED, { signedIn: false, scopes: [] });
}

const writeFresh = () => !!token && expiresAt > Date.now() + 60_000;
/** 읽기용 — 중계 토큰 우선, 없으면 앱 로그인 토큰. */
export const getToken = () => brokerFresh() ? brokerTok : (writeFresh() ? token : (brokerCfg() ? '' : token));
/** 쓰기용(drive.file) — 앱 로그인 토큰만, 만료면 null. */
export const getWriteToken = () => writeFresh() ? token : null;
export const signedIn = () => !!getToken();
export const hasScope = (s) => scopes.includes(s);

/* ── 서비스워커에 토큰 전달 ─────────────────────────────────────────
 *  SW 가 <audio> 요청에 Authorization 을 끼워 넣어야 통째 다운로드 없이
 *  Range 스트리밍이 된다. 토큰은 SW 메모리에만 머문다.
 *  중계 설정(주소·키)도 함께 보낸다 — SW 가 401 을 받으면 스스로 새 토큰을 받는다. */
export function postTokenToSW() {
  try {
    const sw = navigator.serviceWorker;
    const t = getToken();
    if (sw?.controller && t) sw.controller.postMessage({ type: 'token', token: t, broker: brokerCfg() });
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
  if (cached) token = cached;
  restoreBroker();
  // 중계가 있는데 읽기 토큰이 없으면 팝업 없이 받아 온다(~5초). 실패해도 기동은 계속.
  if (brokerCfg() && !brokerFresh()) { try { await refreshBroker(); } catch (e) { log.warn('auth', '토큰 중계 실패', e); } }
  else if (brokerCfg()) scheduleBroker();
  if (writeFresh()) syncBrokerFromDrive(token);
  if (getToken()) {
    patch('auth', { signedIn: true, scopes });
    postTokenToSW();
    emit(EVENTS.AUTH_CHANGED, { signedIn: true, scopes });
  }
  // 앱을 다시 볼 때 중계 토큰이 곧 만료되면 미리 받는다(백그라운드에선 타이머가 늦을 수 있다)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && brokerCfg() && brokerExp - Date.now() < RENEW_AHEAD_MS) {
      refreshBroker().catch(() => {});
    }
  });

  const ok = await waitForGsi();
  if (!ok) {
    log.warn('auth', 'GSI 를 불러오지 못했습니다(오프라인?) — 캐시로 진행');
    return { ok: false, offline: true, signedIn: !!getToken() };
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope,
    include_granted_scopes: true,      // 이미 받은 권한을 유지한 채 더한다
    callback: (resp) => {
      renewing = false;
      if (resp.error) {
        // silent 실패는 조용히 — 사용자가 직접 누르게 둔다
        if (!silentTried) emit(EVENTS.TOAST, { text: '로그인 실패: ' + resp.error, kind: 'error' });
        silentTried = false;
        return;
      }
      store(resp.access_token, resp.expires_in, resp.scope);
    },
    // 팝업이 막히거나 닫힌 경우 — 콜백이 안 오므로 여기서 풀어 줘야 다음 터치에서 다시 시도한다
    error_callback: (err) => {
      renewing = false;
      if (!silentTried) emit(EVENTS.TOAST, { text: '로그인 창을 열지 못했습니다: ' + (err?.type || ''), kind: 'error' });
      silentTried = false;
    },
  });

  armGestureRenew();
  // 처음 쓰는 사람만 기동 때 시도한다. 로그인한 적이 있으면 첫 터치에서 갱신(팝업 차단 회피).
  if (!getToken() && !wasSignedIn()) await trySilent();
  return { ok: true, offline: false, signedIn: !!getToken(), renewable: !getToken() && wasSignedIn() };
}

/** 구글에 이미 로그인돼 있으면 동의 화면 없이 토큰을 받는다. */
export function trySilent() {
  if (!tokenClient) return Promise.resolve(false);
  silentTried = true;
  try { tokenClient.requestAccessToken(withHint({ prompt: '' })); } catch (e) { silentTried = false; }
  return Promise.resolve(true);
}

/** 사용자가 버튼을 눌렀을 때 — 동의 화면을 띄운다. */
export function signIn({ scope } = {}) {
  if (!tokenClient) {
    emit(EVENTS.TOAST, { text: '로그인 준비가 안 됐습니다. 연결을 확인해 주세요.', kind: 'error' });
    return;
  }
  if (renewing && !scope) return;        // 같은 터치에서 armGestureRenew 가 이미 요청했다
  silentTried = false;
  // 이미 동의한 사람이 권한을 더하지 않는다면 동의 화면 없이(prompt:'') — 탭 한 번에 끝난다
  const opts = withHint({ prompt: (wasSignedIn() && !scope) ? '' : 'consent' });
  if (scope) opts.scope = scope;
  renewing = true;
  tokenClient.requestAccessToken(opts);
}

/** 401 을 받았을 때 drive-api 가 부른다.
 *  ‼ 여기서 팝업을 열면 막힌다(터치가 아니다). 토큰만 비우고 '갱신 대기'로 알린다 —
 *    로그인한 적은 그대로 기억하므로 다음 터치에서 armGestureRenew 가 이어 붙인다. */
export function onUnauthorized() {
  // 중계가 있으면 읽기 토큰만 새로 받는다 — 팝업도 띠도 없다
  if (brokerCfg()) {
    log.warn('auth', '읽기 토큰 만료 — 중계에서 다시 받음');
    brokerTok = ''; brokerExp = 0;
    refreshBroker().catch(() => emit(EVENTS.AUTH_CHANGED, { signedIn: false, scopes, renewable: wasSignedIn() }));
    return;
  }
  log.warn('auth', '토큰 만료 — 다음 터치에서 갱신');
  // 받은 권한(scopes)은 남겨 둔다 — 지우면 쓰기 동의를 다시 묻게 된다
  const d = kv.get(TOKEN_KEY);
  if (d) kv.set(TOKEN_KEY, { ...d, expiresAt: 0 });
  token = null;
  expiresAt = 0;
  patch('auth', { signedIn: false });
  emit(EVENTS.AUTH_CHANGED, { signedIn: false, scopes, renewable: wasSignedIn() });
}

/** 4단계에서 쓰기 권한이 필요해질 때. */
export function ensureWriteScope() {
  if (hasScope(SCOPE_WRITE)) return true;
  signIn({ scope: SCOPE_READ + ' ' + SCOPE_WRITE });
  return false;
}
