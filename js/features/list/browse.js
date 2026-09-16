/* browse.js — 수준별로 내려가며 문서를 찾는다.
 *
 *  목록(list.js)은 "이름을 알 때" 쓰는 화면이다. 이건 "무엇이 있는지 볼 때" 쓴다.
 *  데스크톱의 폴더 트리를 폰에서 한 단씩 내려가는 방식으로 옮긴 것.
 *
 *  분류는 지어내지 않는다 — Drive 폴더 경로가 이미 분류다.
 *      archive / 백지 인출 / 경제학 / 거시경제학 01. … / 파일.html
 *      encyclopedia / Library / 학문 / 사회과학 / 경제학 / 거시경제학 / 01. … / 파일.html
 *
 *  ‼ 빈 단계는 건너뛴다. 실측하면 백과사전의 위 두 단(학문 → 사회과학)은
 *    자식이 하나뿐이라 누르는 수고만 늘리고 알려 주는 것이 없다.
 *    자식이 하나뿐인 폴더는 자동으로 뚫고 내려가 빵가루에만 흔적을 남긴다.
 */
import * as shell from '../shell.js';
import * as router from '../../core/router.js';
import { subscribe } from '../../core/store.js';
import { catalog, classify, refresh, markOpened } from '../../data/index.js';

const esc = shell.escapeHtml;
const PAGE = 60;

/* 뿌리 — 타일이 여기로 들어온다 */
export const ROOTS = {
  encyclopedia: { path: 'encyclopedia/Library', title: '백과사전' },
  archive: { path: 'archive', title: '아카이브' },
  recall: { path: 'archive/백지 인출', title: '백지 인출' },
  quiz: { path: 'archive/복기 퀴즈', title: '복기 퀴즈' },
};

let state = { path: '', text: '', shown: PAGE };
let unsub = null;

export function renderBrowse(params = {}) {
  const r = ROOTS[params.root || ''];
  state = { path: params.p || (r ? r.path : 'archive'), text: '', shown: PAGE };

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="search-row">
      <input type="search" id="q" placeholder="이 안에서 찾기" autocomplete="off" enterkeyhint="search">
    </div>
    <nav id="crumb" class="crumb"></nav>
    <div id="body"></div>`;

  const $q = el.querySelector('#q');
  $q.addEventListener('input', () => { state.text = $q.value.trim(); state.shown = PAGE; paint(el); });
  el.addEventListener('click', (e) => onClick(e, el));

  shell.render({ title: titleOf(state.path), back: true, node: el });

  unsub?.();
  unsub = subscribe('catalog', () => paint(el));
  paint(el);

  if (!catalog.files().length) refresh().catch(e => shell.toast(e.message, 'error'));
}

/* ── 한 단계의 내용물 ───────────────────────────────────────────────── */

/**
 * prefix 바로 아래에 무엇이 있는가.
 *   folders: [{seg, path, docs}]  — 하위 전체 문서 수까지 세어 준다
 *   files:   이 폴더에 바로 놓인 문서
 */
function levelAt(prefix) {
  const head = prefix ? prefix + '/' : '';
  const folders = new Map();
  const files = [];
  for (const f of catalog.files()) {
    if (classify.isAudio(f.name)) continue;
    const p = f.path || '';
    if (p !== prefix && !p.startsWith(head)) continue;
    const rest = p === prefix ? '' : p.slice(head.length);
    if (!rest) { files.push(f); continue; }
    const seg = rest.split('/')[0];
    const cur = folders.get(seg);
    if (cur) cur.docs++;
    else folders.set(seg, { seg, path: head + seg, docs: 1 });
  }
  return {
    folders: [...folders.values()].sort((a, b) => cmp(a.seg, b.seg)),
    files: files.sort((a, b) => cmp(a.name, b.name)),
  };
}

/** '01. …' 같은 이름이 10 앞에 오도록 숫자를 숫자로 본다. */
function cmp(a, b) { return a.localeCompare(b, 'ko', { numeric: true }); }

/**
 * 자식이 폴더 하나뿐이고 제 문서가 없으면 계속 내려간다.
 * 사용자가 아무것도 고르지 않는 화면을 보지 않게 하는 것이 목적이다.
 */
function descend(prefix) {
  const skipped = [];
  let cur = prefix;
  for (let i = 0; i < 8; i++) {
    const lv = levelAt(cur);
    if (lv.folders.length === 1 && !lv.files.length) {
      cur = lv.folders[0].path;
      skipped.push(lv.folders[0].seg);
      continue;
    }
    return { path: cur, level: lv, skipped };
  }
  return { path: cur, level: levelAt(cur), skipped };
}

/* ── 그리기 ───────────────────────────────────────────────────────── */

function paint(el) {
  const $body = el.querySelector('#body');

  if (state.text) {                       // 찾는 중에는 이 가지 전체를 평평하게
    el.querySelector('#crumb').innerHTML = crumbHtml(state.path, []);
    $body.innerHTML = searchHtml();
    return;
  }

  const { path, level, skipped } = descend(state.path);
  el.querySelector('#crumb').innerHTML = crumbHtml(path, skipped);

  if (!level.folders.length && !level.files.length) {
    $body.innerHTML = `<div class="empty">${catalog.files().length
      ? '이 폴더에 문서가 없습니다.'
      : '아직 목록을 받지 못했습니다.<br>위 ⟳ 로 새로고침해 주세요.'}</div>`;
    return;
  }

  const shownFiles = level.files.slice(0, state.shown);
  $body.innerHTML = `
    ${level.folders.length ? `<div class="folder-list">${level.folders.map(folderHtml).join('')}</div>` : ''}
    ${level.files.length ? `
      <div class="list-count">이 폴더의 문서 ${level.files.length.toLocaleString()}개</div>
      <div class="doc-list">${shownFiles.map(fileHtml).join('')}</div>
      ${level.files.length > state.shown
        ? `<button class="more-btn pressable" data-more="1">더 보기 (${(level.files.length - state.shown).toLocaleString()}개 남음)</button>`
        : ''}` : ''}`;
}

function folderHtml(d) {
  return `<button class="folder-row pressable" data-dir="${esc(d.path)}">
    <span class="fico">📁</span>
    <span class="fname">${esc(d.seg)}</span>
    <span class="fnum">${d.docs.toLocaleString()}</span>
    <span class="fgo">›</span>
  </button>`;
}

function fileHtml(f) {
  const info = classify.classify(f);
  const heavy = classify.isHeavy(f.size);
  return `<button class="doc-row pressable" data-doc="${esc(f.id)}">
    <span class="doc-name">${esc(info.baseTitle || f.name)}</span>
    <span class="doc-meta">
      <span class="kind k-${info.kind}">${esc(info.label)}</span>
      ${f.audio ? '<span class="kind k-audio">🔊</span>' : ''}
      ${heavy ? `<span class="kind k-heavy">대용량 ${classify.sizeLabel(f.size)}</span>` : ''}
    </span>
  </button>`;
}

/** 빵가루 — 어디까지 내려왔는지, 그리고 한 번에 되돌아갈 길. */
function crumbHtml(path, skipped) {
  const segs = path.split('/').filter(Boolean);
  const out = [];
  let acc = '';
  segs.forEach((s, i) => {
    acc = acc ? acc + '/' + s : s;
    // 'encyclopedia/Library' 두 단은 한 칸으로 — 사용자에게 Library 는 뜻이 없다
    if (s === 'Library') return;
    const label = i === 0 ? (ROOTS[s]?.title || rootLabel(s)) : s;
    const last = i === segs.length - 1;
    out.push(`<button class="crumb-i${last ? ' on' : ''}" data-dir="${esc(acc)}">${esc(label)}</button>`);
  });
  const tail = skipped.length ? `<span class="crumb-skip">${esc(skipped.join(' › '))}</span>` : '';
  return out.join('<span class="crumb-sep">›</span>') + tail;
}

function rootLabel(s) {
  return s === 'encyclopedia' ? '백과사전' : s === 'archive' ? '아카이브' : s;
}

function titleOf(path) {
  const segs = path.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  if (!last || last === 'Library') return rootLabel(segs[0] || '');
  return segs.length === 1 ? rootLabel(last) : last;
}

/** 검색은 지금 가지 아래 전체에서 — 폴더를 오르내리지 않고 바로 찾게. */
function searchHtml() {
  const head = state.path ? state.path + '/' : '';
  const text = state.text.normalize('NFC').toLowerCase();
  const hits = [];
  for (const f of catalog.files()) {
    if (classify.isAudio(f.name)) continue;
    const p = f.path || '';
    if (p !== state.path && !p.startsWith(head)) continue;
    if (!(f.name + ' ' + p).normalize('NFC').toLowerCase().includes(text)) continue;
    hits.push(f);
    if (hits.length > 400) break;
  }
  hits.sort((a, b) => cmp(a.path + a.name, b.path + b.name));
  if (!hits.length) return `<div class="empty">찾는 문서가 없습니다.</div>`;
  const slice = hits.slice(0, state.shown);
  return `<div class="list-count">${hits.length > 400 ? '400개 이상' : hits.length + '개'}</div>
    <div class="doc-list">${slice.map(f => {
      const info = classify.classify(f);
      const where = (f.path || '').slice(head.length);
      return `<button class="doc-row pressable" data-doc="${esc(f.id)}">
        <span class="doc-name">${esc(info.baseTitle || f.name)}</span>
        <span class="doc-meta">
          <span class="kind k-${info.kind}">${esc(info.label)}</span>
          <span class="where">${esc(where.split('/').join(' › '))}</span>
        </span>
      </button>`;
    }).join('')}</div>
    ${hits.length > state.shown
      ? `<button class="more-btn pressable" data-more="1">더 보기</button>` : ''}`;
}

/* ── 손가락 ───────────────────────────────────────────────────────── */

function onClick(e, el) {
  const dir = e.target.closest('[data-dir]');
  if (dir) {
    // 한 단 내려갈 때마다 히스토리를 쌓는다 — 뒤로가기가 한 단씩 올라오게
    router.go('#/browse?p=' + encodeURIComponent(dir.dataset.dir));
    return;
  }
  if (e.target.closest('[data-more]')) { state.shown += PAGE * 2; paint(el); return; }

  const doc = e.target.closest('[data-doc]');
  if (doc) {
    const f = catalog.byId(doc.dataset.doc);
    if (f) markOpened(f);
    router.go('#/doc/' + encodeURIComponent(doc.dataset.doc));
  }
}

export function leave() { unsub?.(); unsub = null; }
