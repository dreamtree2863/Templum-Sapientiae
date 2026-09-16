/* list.js — 문서 목록.
 *
 *  ‼ 옛 코드(app.js:617-736)는 파일명을 정규식으로 *추측*해 분류했다.
 *    Drive 폴더 구조가 이미 정확한 분류다:
 *        archive / 백지 인출 / 경제학 / 거시경제학 01. … / 파일.html
 *                  └ 자료종류  └ 과목    └ 단원
 *    그래서 칩은 경로 세그먼트를 그대로 쓴다. 규칙 하드코딩 0,
 *    폴더가 늘면 칩도 저절로 는다.
 */
import * as shell from '../shell.js';
import * as router from '../../core/router.js';
import { subscribe } from '../../core/store.js';
import { catalog, classify, refresh, markOpened } from '../../data/index.js';

const esc = shell.escapeHtml;
const PAGE = 60;                       // 한 번에 그리는 줄 수 (폰에서 수천 줄은 버겁다)

let q = { root: '', kind: '', l1: '', l2: '', text: '' };
let shown = PAGE;
let unsub = null;

export function renderList(params = {}) {
  q = { root: params.root || '', kind: params.kind || '', l1: '', l2: '', text: '' };
  shown = PAGE;

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="search-row">
      <input type="search" id="q" placeholder="제목·단원으로 찾기" autocomplete="off" enterkeyhint="search">
    </div>
    <div id="chips"></div>
    <div id="count" class="list-count"></div>
    <div id="rows" class="doc-list"></div>
    <div id="more"></div>`;

  shell.render({ title: titleOf(q), back: true, node: el });

  const $q = el.querySelector('#q');
  $q.addEventListener('input', () => { q.text = $q.value.trim(); shown = PAGE; paint(el); });
  el.addEventListener('click', (e) => onClick(e, el));
  if (params.focus === 'search') setTimeout(() => $q.focus(), 60);

  unsub?.();
  unsub = subscribe('catalog', () => paint(el));
  paint(el);

  // 목록에 처음 들어왔고 캐시가 비었으면 바로 받아 온다
  if (!catalog.files().length) refresh().catch(e => shell.toast(e.message, 'error'));
}

function titleOf(q) {
  if (q.kind === 'recall') return '백지 인출';
  if (q.kind === 'quiz') return '복기 퀴즈';
  if (q.kind === 'news') return '뉴스 요약';
  if (q.root === 'encyclopedia') return '백과사전';
  if (q.root === 'archive') return '아카이브';
  return '문서';
}

/* ── 걸러 내기 ────────────────────────────────────────────────────── */
function filtered() {
  const text = q.text.normalize('NFC').toLowerCase();
  const out = [];
  for (const f of catalog.files()) {
    if (classify.isAudio(f.name)) continue;
    if (classify.isSystemPath(f.path)) continue;   // _state·_inbox 는 자료가 아니다
    const seg = classify.segments(f);
    if (q.root && seg.root !== q.root) continue;
    if (q.kind === 'news') {
      if (seg.kindFolder !== '뉴스 요약') continue;
    } else if (q.kind) {
      if (classify.classify(f).kind !== q.kind) continue;
    }
    if (q.l1 && seg.kindFolder !== q.l1) continue;
    if (q.l2 && seg.subject !== q.l2) continue;
    if (text) {
      const hay = (f.name + ' ' + f.path).normalize('NFC').toLowerCase();
      if (!hay.includes(text)) continue;
    }
    out.push({ f, seg });
  }
  out.sort((a, b) => (a.f.path + a.f.name).localeCompare(b.f.path + b.f.name, 'ko'));
  return out;
}

/* ── 그리기 ───────────────────────────────────────────────────────── */
function paint(el) {
  const rows = filtered();
  el.querySelector('#chips').innerHTML = chipsHtml(rows);
  el.querySelector('#count').textContent =
    rows.length ? `${rows.length.toLocaleString()}개` : '';

  const slice = rows.slice(0, shown);
  el.querySelector('#rows').innerHTML = slice.length
    ? slice.map(rowHtml).join('')
    : `<div class="empty">${catalog.files().length
        ? '조건에 맞는 문서가 없습니다.'
        : '아직 목록을 받지 못했습니다.<br>위 ⟳ 로 새로고침해 주세요.'}</div>`;

  el.querySelector('#more').innerHTML = rows.length > shown
    ? `<button class="more-btn pressable" data-more="1">더 보기 (${(rows.length - shown).toLocaleString()}개 남음)</button>`
    : '';
}

/** 칩은 지금 보이는 것들에서 뽑는다 — 고를 수 없는 칩을 띄우지 않는다. */
function chipsHtml(rows) {
  const l1 = new Map(), l2 = new Map();
  for (const { seg } of rows) {
    if (seg.kindFolder) l1.set(seg.kindFolder, (l1.get(seg.kindFolder) || 0) + 1);
    if ((!q.l1 || seg.kindFolder === q.l1) && seg.subject) {
      l2.set(seg.subject, (l2.get(seg.subject) || 0) + 1);
    }
  }
  const row = (map, key, cur) => {
    if (map.size < 2 && !cur) return '';
    const items = [...map.entries()].sort((a, b) => b[1] - a[1]);
    return `<div class="chips">
      <button class="chip${cur ? '' : ' on'}" data-chip="${key}" data-val="">전체</button>
      ${items.map(([k, n]) =>
        `<button class="chip${cur === k ? ' on' : ''}" data-chip="${key}" data-val="${esc(k)}">${esc(k)} <i>${n}</i></button>`
      ).join('')}
    </div>`;
  };
  return row(l1, 'l1', q.l1) + row(l2, 'l2', q.l2);
}

function rowHtml({ f, seg }) {
  const info = classify.classify(f);
  const heavy = classify.isHeavy(f.size);
  const where = [seg.kindFolder, seg.subject, seg.unit].filter(Boolean).join(' › ');
  return `<button class="doc-row pressable" data-doc="${esc(f.id)}">
    <span class="doc-name">${esc(info.baseTitle || f.name)}</span>
    <span class="doc-meta">
      <span class="kind k-${info.kind}">${esc(info.label)}</span>
      ${f.audio ? '<span class="kind k-audio">🔊</span>' : ''}
      ${heavy ? `<span class="kind k-heavy">대용량 ${classify.sizeLabel(f.size)}</span>` : ''}
      <span class="where">${esc(where)}</span>
    </span>
  </button>`;
}

/* ── 손가락 ───────────────────────────────────────────────────────── */
function onClick(e, el) {
  const go = e.target.closest('[data-go]');
  if (go) { router.go(go.dataset.go); return; }

  const chip = e.target.closest('[data-chip]');
  if (chip) {
    q[chip.dataset.chip] = chip.dataset.val;
    if (chip.dataset.chip === 'l1') q.l2 = '';
    shown = PAGE;
    paint(el);
    return;
  }

  if (e.target.closest('[data-more]')) { shown += PAGE * 2; paint(el); return; }

  const doc = e.target.closest('[data-doc]');
  if (doc) {
    const f = catalog.byId(doc.dataset.doc);
    if (f) markOpened(f);
    router.go('#/doc/' + encodeURIComponent(doc.dataset.doc));
  }
}

export function leave() { unsub?.(); unsub = null; }
