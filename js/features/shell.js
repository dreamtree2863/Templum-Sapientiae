/* shell.js — 상단바 · 하단 탭바 · 토스트 · 배너.
 *
 *  화면을 갈아 끼우는 곳은 여기 하나(`render`)다. 옛 show() 처럼
 *  화면 이름을 하드코딩하지 않는다 — 라우터가 준 내용을 꽂기만 한다.
 */
import * as router from '../core/router.js';
import { subscribe, get } from '../core/store.js';
import { on, EVENTS } from '../core/bus.js';

/* 탭 아이콘은 SVG 선 그림 — 이모지는 기기마다 모양·색이 달라 "지금 어느 탭인가"가
   글자색만으로는 잘 안 보였다. 선 그림은 currentColor 를 따라 켜진 탭이 또렷하다. */
const svg = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9v11.5h13V9"/><path d="M10 20.5v-6h4v6"/>'),
  lib: svg('<path d="M2.5 4.5h6a3.5 3.5 0 0 1 3.5 3.5v12.5a2.5 2.5 0 0 0-2.5-2.5h-7z"/><path d="M21.5 4.5h-6A3.5 3.5 0 0 0 12 8v12.5a2.5 2.5 0 0 1 2.5-2.5h7z"/>'),
  work: svg('<path d="M12 20.5h8.5"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5l-4 1 1-4z"/>'),
  review: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M12 8v4.5l3 1.8"/>'),
  settings: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5"/>'),
};
const TABS = [
  { id: 'home', label: '오늘', hash: '#/' },
  { id: 'lib', label: '자료', hash: '#/lib' },
  { id: 'work', label: '학습지', hash: '#/work' },
  { id: 'review', label: '복습', hash: '#/review' },
  { id: 'settings', label: '설정', hash: '#/settings' },
];

let $main, $title, $back, $dot, $tabbar, $toasts;
let renderedHash = null;
const scrollMem = new Map();   // 해시 → 떠날 때의 스크롤 위치
let restoreTimer = null;

export function mount(root) {
  root.innerHTML = `
    <header id="topbar">
      <button class="iconbtn" id="btn-back" hidden aria-label="뒤로">←</button>
      <h1 class="title" id="topbar-title">Templum</h1>
      <button id="sync-dot" data-state="offline" title="동기화 상태" aria-label="동기화 상태"></button>
      <button class="iconbtn" id="btn-refresh" aria-label="새로고침">⟳</button>
    </header>
    <main id="main"></main>
    <nav id="tabbar">${TABS.map(t => `
      <button data-tab="${t.id}" data-hash="${t.hash}">
        <span class="ico">${ICONS[t.id]}</span><span>${t.label}</span>
      </button>`).join('')}
    </nav>
    <div id="toast-host"></div>`;

  $main = root.querySelector('#main');
  $title = root.querySelector('#topbar-title');
  $back = root.querySelector('#btn-back');
  $dot = root.querySelector('#sync-dot');
  $tabbar = root.querySelector('#tabbar');
  $toasts = root.querySelector('#toast-host');

  $back.addEventListener('click', () => router.back());
  // 점만으로는 뜻을 모른다(폰에는 툴팁이 없다) — 누르면 동기화 상태로 간다
  $dot.addEventListener('click', () => router.go('#/settings/sync'));
  $tabbar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-hash]');
    if (b) router.go(b.dataset.hash);
  });

  on(EVENTS.TOAST, ({ text, kind }) => toast(text, kind));
  on(EVENTS.STORAGE_FULL, () => banner(
    '저장 공간이 찼습니다. 설정에서 정리해 주세요.',
    { action: '설정 열기', onAction: () => router.go('#/settings') }));

  subscribe('ui', () => paintTabs());
  subscribe('outbox', (o) => paintDot(o));
  window.addEventListener('online', () => paintDot(get('outbox')));
  window.addEventListener('offline', () => paintDot(get('outbox')));
}

/** 라우트 핸들러가 부르는 단 하나의 진입점. */
export function render({ title = 'Templum', back = false, html = '', node = null, chrome = true }) {
  $title.textContent = title;
  $back.hidden = !back;
  document.getElementById('topbar').classList.toggle('hidden', !chrome);
  $tabbar.classList.toggle('hidden', !chrome);
  $main.classList.toggle('hidden', false);
  /* ‼ 떠나는 화면의 위치를 적어 두고, 뒤로가기로 돌아오면 그 자리로 보낸다.
     6백여 폴더 목록에서 문서 하나 보고 돌아올 때마다 맨 위로 튀던 것을 막는다. */
  if (renderedHash) scrollMem.set(renderedHash, window.scrollY);
  renderedHash = location.hash || '#/';
  if (node) { $main.replaceChildren(node); } else { $main.innerHTML = html; }
  $main.scrollTop = 0;
  window.scrollTo(0, 0);
  clearTimeout(restoreTimer);
  const y = router.isPop() ? scrollMem.get(renderedHash) : 0;
  if (y) restoreScroll(y);
  paintTabs();
  return $main;
}

/** 내용은 render 뒤에 채워지는 화면이 많다 — 높이가 차오를 때까지 잠깐 다시 시도한다. */
function restoreScroll(y) {
  let tries = 0;
  const step = () => {
    window.scrollTo(0, y);
    if (Math.abs(window.scrollY - y) > 2 && ++tries < 20) restoreTimer = setTimeout(step, 50);
  };
  restoreTimer = setTimeout(step, 0);
}

export function main() { return $main; }

function paintTabs() {
  const active = router.activeTab();
  $tabbar.querySelectorAll('button[data-tab]').forEach(b => {
    if (b.dataset.tab === active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

function paintDot(outbox) {
  if (!$dot) return;
  const pending = outbox?.pending || 0;
  const state = !navigator.onLine ? 'offline' : pending ? 'pending' : 'ok';
  $dot.dataset.state = state;
  $dot.title = state === 'offline' ? '오프라인'
    : pending ? `보내지 못한 기록 ${pending}건` : '최신 상태';
  $dot.setAttribute('aria-label', '동기화: ' + $dot.title);
}

/* ── 알림 ─────────────────────────────────────────────────────────── */
export function toast(text, kind = 'info', ms = 2600) {
  if (!$toasts) return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind && kind !== 'info' ? ' ' + kind : '');
  el.textContent = text;
  $toasts.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** 화면 위쪽에 남아 있는 알림 — 토스트보다 무거운 소식용. */
export function banner(text, { action, onAction } = {}) {
  if (!$main) return;
  const el = document.createElement('div');
  el.className = 'banner';
  el.innerHTML = `<span style="flex:1">${escapeHtml(text)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.style.cssText = 'font-weight:700;color:inherit;text-decoration:underline;min-height:auto';
    b.addEventListener('click', () => { el.remove(); onAction?.(); });
    el.appendChild(b);
  }
  $main.prepend(el);
}

/** 오래 걸리는 일의 진행 표시 — 하나만 뜨고 글자만 바뀐다.
 *  ‼ 목록을 9천 개 받는 동안 아무 말도 없으면 사용자는 "또 안 되는구나" 한다.
 *    숫자가 오르는 것이 보여야 기다린다. 화면을 옮겨도 살아 있어야 해서 셸에 붙인다. */
let $progress = null;

export function progress(text) {
  if (!$progress) {
    $progress = document.createElement('div');
    $progress.className = 'banner progress';
    document.body.appendChild($progress);
  }
  $progress.textContent = text;
}

export function progressDone(text) {
  if (!$progress) return;
  if (text) {
    $progress.textContent = text;
    const el = $progress;
    setTimeout(() => el.remove(), 2500);
  } else {
    $progress.remove();
  }
  $progress = null;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
