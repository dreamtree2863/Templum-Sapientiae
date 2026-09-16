/* shell.js — 상단바 · 하단 탭바 · 토스트 · 배너.
 *
 *  화면을 갈아 끼우는 곳은 여기 하나(`render`)다. 옛 show() 처럼
 *  화면 이름을 하드코딩하지 않는다 — 라우터가 준 내용을 꽂기만 한다.
 */
import * as router from '../core/router.js';
import { subscribe, get } from '../core/store.js';
import { on, EVENTS } from '../core/bus.js';

const TABS = [
  { id: 'lib', ico: '📚', label: '자료', hash: '#/lib' },
  { id: 'work', ico: '✍️', label: '학습지', hash: '#/work' },
  { id: 'review', ico: '🧠', label: '복습', hash: '#/review' },
  { id: 'settings', ico: '⚙️', label: '설정', hash: '#/settings' },
];

let $main, $title, $back, $dot, $tabbar, $toasts;

export function mount(root) {
  root.innerHTML = `
    <header id="topbar">
      <button class="iconbtn" id="btn-back" hidden aria-label="뒤로">←</button>
      <h1 class="title" id="topbar-title">Templum</h1>
      <span id="sync-dot" data-state="offline" title="동기화 상태"></span>
      <button class="iconbtn" id="btn-refresh" aria-label="새로고침">⟳</button>
    </header>
    <main id="main"></main>
    <nav id="tabbar">${TABS.map(t => `
      <button data-tab="${t.id}" data-hash="${t.hash}">
        <span class="ico">${t.ico}</span><span>${t.label}</span>
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
  if (node) { $main.replaceChildren(node); } else { $main.innerHTML = html; }
  $main.scrollTop = 0;
  window.scrollTo(0, 0);
  paintTabs();
  return $main;
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

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
