/* home.js — 홈과 허브 넷.
 *
 *  데스크톱의 3단 계층을 그대로 옮긴다.
 *      메인(타이틀+위젯+큰 버튼)  →  허브(제목+설명+타일 그리드)  →  기능
 *
 *  ‼ 타일은 "지금 할 수 있는 일"을 말해야 한다. 아직 안 만든 기능은
 *    숨기지 말고 흐리게(disabled) 두어, 앱이 어디까지 자랐는지 보이게 한다.
 */
import * as shell from './shell.js';
import * as router from '../core/router.js';
import { get } from '../core/store.js';
import { catalog, recents, inProgress } from '../data/index.js';
import { classify } from '../data/index.js';

const esc = shell.escapeHtml;

/* ── 홈 ───────────────────────────────────────────────────────────── */
export async function renderHome() {
  const c = get('catalog');
  const ob = get('outbox');
  const rev = get('review');

  const el = document.createElement('div');
  el.id = 'screen-home';
  el.innerHTML = `
    <div class="home-head">
      <h1 class="home-title">Templum</h1>
      <p class="home-sub">지혜를 향한 여정의 동반자</p>
    </div>
    <div class="home-body">
      <div class="widgets">
        <div class="widget"><span class="n" id="w-docs">${c.total || '—'}</span><span class="k">자료</span></div>
        <div class="widget"><span class="n" id="w-review">${rev.due || 0}</span><span class="k">오늘 복습</span></div>
        <div class="widget"><span class="n" id="w-outbox">${ob.pending || 0}</span><span class="k">보낼 기록</span></div>
      </div>
      <div class="home-tiles">
        ${tile('📚', '자료', '백과·아카이브 열람', '#/lib')}
        ${tile('✍️', '학습지', '백지인출 · 복기퀴즈', '#/work')}
        ${tile('🧠', '복습', '오늘의 복습 · 객관식', '#/review')}
        ${tile('⚙️', '설정', '동기화 · 저장공간', '#/settings')}
      </div>
    </div>`;

  el.addEventListener('click', onTileClick);
  shell.render({ title: 'Templum', back: false, node: el });
}

function tile(ico, label, sub, hash, disabled) {
  return `<button class="home-tile pressable" data-go="${hash}"${disabled ? ' disabled' : ''}>
    <span class="ico">${ico}</span>
    <span class="label">${esc(label)}</span>
    <span class="sub">${esc(sub)}</span>
  </button>`;
}

function onTileClick(e) {
  const b = e.target.closest('[data-go]');
  if (b && !b.disabled) router.go(b.dataset.go);
}

/* ── 허브 ─────────────────────────────────────────────────────────── */

const HUBS = {
  lib: {
    title: '📚 자료',
    desc: '백과사전과 아카이브 문서를 찾아 읽습니다.',
    tiles: [
      // 분야 → 과목 → 단원으로 한 단씩 내려간다(browse). 이름을 알 때는 🔍 로.
      { ico: '📖', label: '백과사전', sub: '분야 → 과목 → 단원', go: '#/browse?root=encyclopedia' },
      { ico: '🗃️', label: '아카이브', sub: '종류 → 과목 → 세트', go: '#/browse?root=archive' },
      { ico: '🕘', label: '최근 본 문서', sub: '', go: '#/lib/recent' },
      { ico: '📰', label: '뉴스 요약', sub: '시사', go: '#/lib/docs?kind=news' },
      { ico: '🔍', label: '검색', sub: '제목·경로', go: '#/lib/docs?focus=search' },
      { ico: '🤖', label: '문서 AI', sub: '7단계', go: '', off: true },
    ],
  },
  work: {
    title: '✍️ 학습지',
    desc: '빈칸을 채우고 채점합니다. 답은 이 기기에 저장됩니다.',
    tiles: [
      { ico: '📝', label: '백지 인출', sub: '과목 → 단원', go: '#/browse?root=recall', count: 'recall' },
      { ico: '🔁', label: '복기 퀴즈', sub: '과목 → 세트', go: '#/browse?root=quiz', count: 'quiz' },
      { ico: '▶️', label: '이어서 풀기', sub: '풀다 만 것', go: '#/work/resume' },
      { ico: '📄', label: '내 답안', sub: '4단계', go: '', off: true },
    ],
  },
  review: {
    title: '🧠 복습',
    desc: '짧은 시간에 되짚습니다.',
    tiles: [
      { ico: '🗓️', label: '오늘의 복습', sub: '5단계', go: '', off: true },
      { ico: '🃏', label: '복습 카드', sub: '5단계', go: '', off: true },
      { ico: '🔘', label: '객관식 시험', sub: '6단계', go: '', off: true },
      { ico: '❌', label: '오답 재시험', sub: '6단계', go: '', off: true },
    ],
  },
  settings: {
    title: '⚙️ 설정 · 동기화',
    desc: '연결 상태와 앱 설정입니다.',
    tiles: [
      { ico: '🔄', label: '동기화 상태', sub: '', go: '#/settings/sync' },
      { ico: '💾', label: '저장 공간', sub: '', go: '#/settings/storage' },
      { ico: '🎨', label: '테마 · 글자 크기', sub: '', go: '#/settings/display' },
      { ico: '📋', label: '기록', sub: '진단 로그', go: '#/settings/log' },
    ],
  },
};

export async function renderHub(name) {
  const hub = HUBS[name];
  if (!hub) { router.go('#/', { replace: true }); return; }

  // 타일에 숫자를 붙인다 — "무엇이 얼마나 있는가"가 고르는 데 가장 큰 정보
  const counts = countByKind();

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="hub-head">
      <h2>${esc(hub.title)}</h2>
      <p>${esc(hub.desc)}</p>
    </div>
    <div class="tiles">
      ${hub.tiles.map(t => {
        const n = t.count ? counts[t.count] : 0;
        const sub = t.count ? (n ? `${n}편` : '목록 받는 중') : t.sub;
        // ‼ 0편이라고 잠그지 않는다. 목록을 아직 못 받았을 때 잠가 버리면
        //   사용자가 들어가서 "왜 비었는지"를 볼 길조차 막힌다(실제로 겪은 일).
        const off = t.off;
        return `<button class="tile pressable" data-go="${t.go}"${off ? ' disabled' : ''}>
          <span class="ico">${t.ico}</span>
          <span class="body">
            <span class="label">${esc(t.label)}</span>
            ${sub ? `<span class="sub">${esc(sub)}</span>` : ''}
          </span>
        </button>`;
      }).join('')}
    </div>`;

  el.addEventListener('click', onTileClick);
  shell.render({ title: hub.title.replace(/^\S+\s/, ''), back: true, node: el });
}

function countByKind() {
  const out = {};
  for (const f of catalog.files()) {
    if (classify.isAudio(f.name)) continue;
    const k = classify.classify(f).kind;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/* ── 작은 목록 화면 두 개 ──────────────────────────────────────────── */
export async function renderRecent() {
  const list = await recents(30);
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="hub-head"><h2>🕘 최근 본 문서</h2></div>
    ${list.length ? `<div class="doc-list">${list.map(r => `
      <button class="doc-row pressable" data-doc="${esc(r.id)}">
        <span class="doc-name">${esc(r.name.replace(/\.html?$/i, ''))}</span>
        <span class="doc-meta">${esc(r.path)}</span>
      </button>`).join('')}</div>`
      : `<div class="empty">아직 연 문서가 없습니다.<br>자료에서 하나 열어 보세요.</div>`}`;
  el.addEventListener('click', onListClick);
  shell.render({ title: '최근 본 문서', back: true, node: el });
}

export async function renderResume() {
  const list = await inProgress(30);
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="hub-head"><h2>▶️ 이어서 풀기</h2>
      <p>읽던 자리가 남아 있는 학습지입니다.</p></div>
    ${list.length ? `<div class="doc-list">${list.map(r => `
      <button class="doc-row pressable" data-doc="${esc(r.id)}">
        <span class="doc-name">${esc((r.name || '').replace(/\.html?$/i, ''))}</span>
        <span class="doc-meta">${esc(r.path || '')}</span>
      </button>`).join('')}</div>`
      : `<div class="empty">풀던 학습지가 없습니다.</div>`}`;
  el.addEventListener('click', onListClick);
  shell.render({ title: '이어서 풀기', back: true, node: el });
}

function onListClick(e) {
  const go = e.target.closest('[data-go]');
  if (go) { router.go(go.dataset.go); return; }
  const doc = e.target.closest('[data-doc]');
  if (doc) router.go('#/doc/' + encodeURIComponent(doc.dataset.doc));
}
