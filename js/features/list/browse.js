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

/* 뿌리 — 타일이 여기로 들어온다.
 *
 *  ‼ 학습지 뿌리는 **경로를 적어 두지 않는다.** 폴더 이름을 코드에 박아 두면
 *    Drive 가 돌려주는 이름과 한 글자만 달라도(유니코드 정규화·공백) 빈 화면이 된다.
 *    대신 카탈로그에서 그 종류(recall/quiz)의 문서가 실제로 사는 곳을 찾아 쓴다.
 *    이러면 폴더 이름이 바뀌어도 따라간다.
 */
export const ROOTS = {
  encyclopedia: { path: 'encyclopedia/Library', title: '백과사전' },
  archive: { path: 'archive', title: '아카이브' },
  recall: { kind: 'recall', title: '백지 인출', fallback: 'archive/백지 인출' },
  quiz: { kind: 'quiz', title: '복기 퀴즈', fallback: 'archive/복기 퀴즈' },
};

/** 이 종류의 문서가 가장 많이 사는 상위 폴더를 찾는다(2단까지). */
function rootOfKind(kind, fallback) {
  const count = new Map();
  for (const f of catalog.files()) {
    if (classify.isAudio(f.name) || classify.isSystemPath(f.path)) continue;
    if (classify.classify(f).kind !== kind) continue;
    const segs = (f.path || '').split('/').filter(Boolean).slice(0, 2).join('/');
    if (segs) count.set(segs, (count.get(segs) || 0) + 1);
  }
  if (!count.size) return fallback;
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function rootPath(r) {
  return r.kind ? rootOfKind(r.kind, r.fallback) : r.path;
}

let state = { path: '', text: '', shown: PAGE };
let unsub = null;

export function renderBrowse(params = {}) {
  const r = ROOTS[params.root || ''];
  state = { path: params.p || (r ? rootPath(r) : 'archive'), text: '', shown: PAGE };

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
    // 앱이 쓰는 내부 폴더(_state·_inbox)는 자료가 아니다 — 목록에 띄우지 않는다
    if (classify.isSystemPath(p)) continue;
    if (p !== prefix && !p.startsWith(head)) continue;
    const rest = p === prefix ? '' : p.slice(head.length);
    if (!rest) { files.push(f); continue; }
    const seg = rest.split('/')[0];
    const cur = folders.get(seg);
    if (cur) cur.docs++;
    else folders.set(seg, { seg, path: head + seg, docs: 1 });
  }
  const fl = [...folders.values()];
  // 날짜 폴더(YYYY-MM-DD)만 있는 단은 **최신이 위** — 뉴스 요약처럼 날짜로 쌓이는
  // 곳에서 73칸을 끝까지 내려야 오늘 것이 나오는 일을 막는다. 이름을 박지 않고
  // 폴더 이름 모양으로만 판단하므로 폴더가 바뀌어도 따라간다.
  const byDate = fl.length > 1 && fl.every(d => isDateSeg(d.seg));
  return {
    folders: fl.sort((a, b) => byDate ? cmp(b.seg, a.seg) : cmp(a.seg, b.seg)),
    files: files.sort((a, b) => isDateSeg(prefix.split('/').pop() || '')
      ? cmp(b.name, a.name) : cmp(a.name, b.name)),
  };
}

/** 'YYYY-MM-DD' 모양인가 — 날짜로 쌓이는 폴더를 알아보는 유일한 근거. */
function isDateSeg(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

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
    $body.innerHTML = emptyWhy(path);
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

/* ‼ 빈 화면은 반드시 **왜** 비었는지 말해야 한다.
   "파일이 없다"만 띄우면 목록을 못 받은 것인지, 폴더가 안 맞는 것인지 알 수 없다. */
function emptyWhy(path) {
  const total = catalog.files().length;
  if (!total) {
    return `<div class="empty">아직 목록을 받지 못했습니다.<br>
      위 ⟳ 로 새로고침하거나, 설정 → 동기화에서 <b>전체 다시 훑기</b>를 눌러 주세요.</div>`;
  }
  // 종류로 세어 보고, 있는데 여기 없으면 어디 있는지 알려 준다
  const kinds = { 'archive/백지 인출': 'recall', 'archive/복기 퀴즈': 'quiz' };
  const kind = kinds[path];
  if (kind) {
    const real = rootOfKind(kind, '');
    const n = catalog.files().filter(f => !classify.isAudio(f.name)
      && classify.classify(f).kind === kind).length;
    if (n && real && real !== path) {
      return `<div class="empty">이 경로에는 없지만 <b>${esc(real)}</b> 에 ${n}편 있습니다.
        <br>아래에서 열어 보세요.</div>
        <button class="more-btn pressable" data-dir="${esc(real)}">${esc(real)} 로 가기</button>`;
    }
    if (!n) {
      return `<div class="empty">받아 둔 목록 ${total.toLocaleString()}개 중
        ${esc(kind === 'recall' ? '백지 인출' : '복기 퀴즈')}이 0편입니다.<br>
        설정 → 동기화에서 <b>전체 다시 훑기</b>를 눌러 주세요.</div>`;
    }
  }
  return `<div class="empty">이 폴더에 문서가 없습니다.
    <br><small>받아 둔 목록은 ${total.toLocaleString()}개입니다.</small></div>`;
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
    if (classify.isSystemPath(p)) continue;
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
