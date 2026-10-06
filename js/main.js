/* main.js — 기동. 서비스워커 등록 · 라우트 등록 · 첫 화면.
 *
 *  ‼ 오프라인이어도 앱이 열려야 한다.
 *    옛 구조는 GSI(구글 로그인 스크립트)를 못 받으면 로그인 화면에 갇혔다.
 *    지하철에서 앱이 먹통이 되던 원인이 그것이다. 여기서는 캐시된 목록으로 들여보낸다.
 */
import * as router from './core/router.js';
import * as store from './core/store.js';
import * as log from './core/log.js';
import { on, EVENTS } from './core/bus.js';
import * as data from './data/index.js';
import * as shell from './features/shell.js';
import * as home from './features/home.js';
import * as list from './features/list/list.js';
import * as browse from './features/list/browse.js';
import * as settings from './features/settings/settings.js';
import * as viewer from './features/viewer/viewer.js';
import * as update from './features/update.js';
import * as reviewUi from './features/review/review.js';
import * as mcqUi from './features/mcq/mcq.js';
import * as aiUi from './features/ai/ai.js';
import * as writeUi from './features/write/write.js';

const THEME_KEY = 'ui.theme';
const SCALE_KEY = 'ui.textScale';

/* ── 테마 — 셸과 문서(iframe)가 같은 값을 쓴다 ─────────────────────── */
function applyTheme(theme) {
  const t = theme || 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  store.patch('ui', { theme: t });
}

/* ── 라우트 ───────────────────────────────────────────────────────── */
function routes() {
  router.route('#/', () => home.renderHome());
  router.route('#/lib', () => home.renderHub('lib'));
  router.route('#/work', () => home.renderHub('work'));
  router.route('#/review', () => home.renderHub('review'));
  router.route('#/settings', () => home.renderHub('settings'));

  router.route('#/lib/recent', () => home.renderRecent());
  router.route('#/work/resume', () => home.renderResume());
  router.route('#/work/answers', () => home.renderAnswers());

  // #/lib/docs?root=archive&kind=recall — 이름을 알 때 쓰는 평면 목록
  router.route('#/lib/docs', () => list.renderList(router.query()));
  // #/browse?root=recall  또는  #/browse?p=archive/백지 인출/경제학 — 수준별로 내려간다
  router.route('#/browse', () => browse.renderBrowse(router.query()));

  router.route('#/settings/sync', () => settings.renderSync());
  router.route('#/settings/storage', () => settings.renderStorage());
  router.route('#/settings/display', () => settings.renderDisplay());
  router.route('#/settings/ai', () => settings.renderAi());
  router.route('#/settings/log', () => settings.renderLog());

  router.route('#/review/today', () => reviewUi.renderToday());
  router.route('#/review/mcq', () => mcqUi.renderSets());
  router.route('#/review/wrong', () => mcqUi.renderWrong());
  router.route('#/lib/ai', () => aiUi.renderAi());

  router.route('#/doc/:id', ({ id }) => viewer.open(id));
  // 답안·목차 쓰기 — #/write/<문제 id>?mode=answer|toc
  router.route('#/write/:id', ({ id }) => writeUi.open(id, router.query()));

  router.setNotFound(() => router.go('#/', { replace: true }));

  // 문서에서 다른 곳으로 가면 프레임을 확실히 버린다(메모리·히스토리)
  window.addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#/doc/')) viewer.close();
    if (!location.hash.startsWith('#/write/')) writeUi.close();
  });
}


/* ── 폰 → PC 보내기 ───────────────────────────────────────────────────
 *  폰은 언제든 앱이 죽고 지하철에서는 끊긴다. 그래서 기회가 생길 때마다 보낸다 —
 *  한 곳에만 걸어 두면 반드시 놓친다. (보내는 일 자체는 data/uplink.js)
 */
function wireUplink() {
  const go = () => { data.uplink.flush().catch(() => {}); };
  window.addEventListener('online', go);
  document.addEventListener('visibilitychange', go);   // 앱을 떠날 때·돌아올 때
  window.addEventListener('hashchange', go);           // 화면을 옮길 때
  setInterval(go, 30 * 60 * 1000);                     // 오래 켜 두는 경우
  go();
}

/* ── 설정 링크(#broker=<base64url JSON {url,key}>) ─────────────────────
 *  폰에서 한 번 누르면 토큰 중계가 설정된다. 주소·키는 이 기기에만 저장하고
 *  주소창에서 즉시 지운다 — 공개 저장소라 코드에 키를 넣으면 누구나 Drive 를 읽게 된다.
 *  라우터보다 먼저 처리해야 '#broker=' 가 화면 주소로 오해받지 않는다. */
function takeBrokerLink() {
  const m = location.hash.match(/^#broker=([A-Za-z0-9_-]+)$/);
  if (!m) return '';
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const cfg = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(cfg.url || '') || !cfg.key) throw new Error('bad');
    data.auth.saveBrokerCfg(cfg.url, cfg.key);
    return 'ok';
  } catch (e) { return 'bad'; }
}

/* ── 기동 ─────────────────────────────────────────────────────────── */
async function boot() {
  const linked = takeBrokerLink();
  const kvTheme = localStorage.getItem('templum.' + THEME_KEY);
  applyTheme(kvTheme ? JSON.parse(kvTheme) : 'system');
  const kvScale = localStorage.getItem('templum.' + SCALE_KEY);
  store.patch('ui', { textScale: kvScale ? JSON.parse(kvScale) : 1 });

  shell.mount(document.getElementById('app'));
  routes();
  update.registerSW();

  window.addEventListener('online', () => store.patch('ui', { online: true }));
  window.addEventListener('offline', () => store.patch('ui', { online: false }));

  /* 목록을 받는 동안 숫자가 오르는 것을 보여 준다.
     ‼ 9천 개를 받는 몇 분 동안 아무 말이 없으면 "또 안 되는구나" 하게 된다. */
  on(EVENTS.CATALOG_PROGRESS, ({ count }) => {
    shell.progress(`자료 목록을 받는 중… ${count.toLocaleString()}개`);
    const el = document.querySelector('#count');
    if (el) el.textContent = `받는 중… ${count.toLocaleString()}개`;
  });
  on(EVENTS.CATALOG_CHANGED, ({ total }) => {
    shell.progressDone(total ? `자료 ${total.toLocaleString()}개를 받았습니다` : '');
  });

  router.start();                       // 캐시가 없어도 화면은 먼저 띄운다
  if (linked === 'ok') shell.toast('토큰 중계를 설정했습니다 — 1시간 제한이 풀립니다', 'ok');
  if (linked === 'bad') shell.toast('설정 링크가 올바르지 않습니다', 'error');

  let res;
  try {
    res = await data.boot();
  } catch (e) {
    log.error('boot', '기동 실패', e);
    shell.toast('기동 중 문제가 생겼습니다.', 'error');
    return;
  }
  wireUplink();
  log.info('boot', `캐시 ${res.cached}개 · 로그인 ${res.signedIn ? 'O' : 'X'}${res.offline ? ' · 오프라인' : ''}`);

  const $refresh = document.getElementById('btn-refresh');
  $refresh?.addEventListener('click', async () => {
    if (!data.auth.signedIn()) { data.auth.signIn(); return; }
    $refresh.classList.add('spinning');
    try {
      const r = await data.refresh();
      if (!r.skipped) {
        shell.toast(r.mode === 'nochange' ? '이미 최신입니다'
          : `${(r.total || 0).toLocaleString()}개 확인`, 'ok');
      }
    } catch (e) {
      shell.toast(e.message || '새로고침 실패', 'error');
    } finally { $refresh.classList.remove('spinning'); }
  });

  /* 토큰 만료 ≠ 로그아웃. 로그인한 적이 있으면 '터치하면 이어진다'는 띠만 띄우고,
     첫 터치에서 auth 가 조용히 갱신한다(설치형 PWA 는 터치 없는 팝업을 막는다). */
  let renewBanner = null;
  let refreshAfterRenew = false;
  const showRenewBanner = (writeOnly) => {
    if (renewBanner?.isConnected) return;
    shell.banner(writeOnly
      ? 'PC 로 보낼 기록이 있습니다 — 화면을 한 번 누르면 이어서 보냅니다.'
      : '연결이 만료됐습니다 — 화면을 한 번 누르면 다시 연결됩니다.',
      { action: '다시 연결', onAction: () => data.auth.renew() });
    renewBanner = document.querySelector('.banner');
    refreshAfterRenew = !writeOnly;
  };
  on(EVENTS.AUTH_CHANGED, ({ signedIn, renewable }) => {
    // 토큰 중계가 있으면 읽기는 늘 되고, 띠는 '보낼 기록이 쓰기 로그인을 기다릴 때'만 뜬다
    const writeWait = data.auth.brokerStatus().writeWanted;
    if (signedIn && !writeWait) {
      if (renewBanner?.isConnected) renewBanner.remove();
      renewBanner = null;
      if (refreshAfterRenew) {
        refreshAfterRenew = false;
        data.refresh().catch(e => log.warn('auth', '재연결 후 새로고침 실패', e));
      }
      if (data.auth.getWriteToken()) data.uplink.flush().catch(() => {});   // 밀린 기록이 있으면 바로 보낸다
    } else if (renewable) {
      showRenewBanner(signedIn && writeWait);
    }
  });
  // 앱을 다시 볼 때 곧 만료될 토큰이면 미리 알려 둔다(갱신 자체는 다음 터치에서)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine && data.auth.needsRenew() && !data.auth.getToken()) {
      showRenewBanner();
    }
  });

  if (res.signedIn) {
    data.refresh().catch(e => log.warn('boot', '첫 새로고침 실패', e));
  } else if (res.renewable && !res.offline) {
    showRenewBanner();
  } else if (!res.offline) {
    shell.banner('구글 계정으로 로그인하면 자료를 받아옵니다.',
      { action: '로그인', onAction: () => data.auth.signIn() });
  } else if (!res.cached) {
    shell.banner('오프라인입니다. 연결되면 자료를 받아옵니다.');
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
