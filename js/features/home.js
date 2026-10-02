/* home.js — 홈("오늘")과 허브 넷.
 *
 *  ‼ 홈은 메뉴가 아니라 **오늘 할 일**이다. 옛 홈은 큰 타일 4개였는데 하단 탭과 똑같은
 *    목록이라, 무엇을 하든 홈 → 허브 → 목록 → 문서로 네 번을 눌러야 했다.
 *    이제 홈은 시험까지 남은 날 · 오늘 복습 · 이어서 볼 문서 · 오늘 뉴스를 바로 꺼내 주고,
 *    메뉴는 하단 탭이 맡는다.
 *
 *  ‼ 타일은 "지금 할 수 있는 일"을 말해야 한다. 아직 안 만든 기능은
 *    숨기지 말고 흐리게(disabled) 두어, 앱이 어디까지 자랐는지 보이게 한다.
 */
import * as shell from './shell.js';
import * as router from '../core/router.js';
import { get, subscribe } from '../core/store.js';
import * as kv from '../core/kv.js';
import { catalog, recents, inProgress, myAnswers, outbox } from '../data/index.js';
import { classify } from '../data/index.js';

const esc = shell.escapeHtml;

/* ── 시험일(D-day) — 이 기기에만 둔다. 설정 › 표시에서 정한다 ─────────── */
export const EXAM_KEY = 'exam';      // {name, date:'YYYY-MM-DD'}

export function examInfo() {
  const e = kv.get(EXAM_KEY);
  if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) return null;
  const [y, m, d] = e.date.split('-').map(Number);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(y, m - 1, d) - today) / 86_400_000);
  return { name: e.name || '시험', date: e.date, days };
}

function ddayText(days) {
  return days > 0 ? `D-${days}` : days === 0 ? 'D-DAY' : `D+${-days}`;
}

/* ── 오늘 뉴스 — 날짜 폴더 중 가장 최근 것 ─────────────────────────────
 *  경로 'archive/뉴스 요약/YYYY-MM-DD/…' 를 모양으로만 찾는다(폴더 이름을 박지 않는다). */
function latestNews() {
  let best = null;
  for (const f of catalog.files()) {
    const m = (f.path || '').normalize('NFC').match(/^(.*뉴스 요약)\/(\d{4}-\d{2}-\d{2})$/);
    if (!m || classify.isAudio(f.name)) continue;
    if (!best || m[2] > best.date) best = { date: m[2], dir: f.path, n: 0 };
    if (m[2] === best.date) best.n++;
  }
  return best;
}

/* ── 홈 ───────────────────────────────────────────────────────────── */
let unsubHome = null;

export async function renderHome() {
  const el = document.createElement('div');
  el.id = 'screen-home';
  el.addEventListener('click', onTileClick);
  shell.render({ title: 'Templum', back: false, node: el });

  const paint = async () => {
    const [resume, recent, pend] = await Promise.all([
      inProgress(3).catch(() => []), recents(3).catch(() => []), outbox.pending().catch(() => []),
    ]);
    if (!el.isConnected) return;
    el.innerHTML = homeHtml({ resume, recent, pend: pend.length });
  };
  unsubHome?.();
  const offs = ['catalog', 'review', 'outbox'].map(k => subscribe(k, () => {
    if (el.isConnected) paint(); else { offs.forEach(f => f()); }
  }));
  unsubHome = () => offs.forEach(f => f());
  await paint();
}

function homeHtml({ resume, recent, pend }) {
  const rev = get('review');
  const c = get('catalog');
  const exam = examInfo();
  const now = new Date();
  const dateLabel = now.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  const news = latestNews();
  // 이어서 볼 것 — 풀던 학습지가 먼저, 없으면 최근 본 문서
  const cont = (resume.length ? resume : recent).slice(0, 3);
  const contTitle = resume.length ? '이어서 풀기' : '최근 본 문서';

  return `
    <section class="today-hero">
      <p class="today-date">${esc(dateLabel)}</p>
      ${exam ? `
        <button class="today-dday pressable" data-go="#/settings/display">
          <span class="dd">${ddayText(exam.days)}</span>
          <span class="dn">${esc(exam.name)} · ${esc(exam.date.replace(/-/g, '.'))}</span>
        </button>` : `
        <button class="today-dday unset pressable" data-go="#/settings/display">
          <span class="dn">시험일을 정하면 남은 날을 세어 드립니다 ›</span>
        </button>`}
    </section>

    <button class="today-card pressable${rev.due ? ' hot' : ''}" data-go="#/review/today">
      <span class="tc-k">오늘 복습</span>
      <span class="tc-v">${rev.due ? `${rev.due}장` : rev.total ? '오늘 몫은 끝났습니다' : '카드 없음'}</span>
      <span class="tc-go">${rev.due ? '시작 ›' : '›'}</span>
    </button>

    ${news ? `
    <button class="today-card pressable" data-go="#/browse?p=${encodeURIComponent(news.dir)}">
      <span class="tc-k">뉴스 요약</span>
      <span class="tc-v">${esc(news.date.slice(5).replace('-', '.'))} · ${news.n}편</span>
      <span class="tc-go">›</span>
    </button>` : ''}

    ${pend ? `
    <button class="today-card pressable warn" data-go="#/work/answers">
      <span class="tc-k">PC 로 보낼 기록</span>
      <span class="tc-v">${pend}건</span>
      <span class="tc-go">›</span>
    </button>` : ''}

    <h3 class="today-sub">${contTitle}</h3>
    ${cont.length ? `<div class="doc-list">${cont.map(r => `
      <button class="doc-row pressable" data-doc="${esc(r.id)}">
        <span class="doc-name">${esc((r.name || '').replace(/\.html?$/i, ''))}</span>
        <span class="doc-meta"><span class="where">${esc(r.path || '')}</span></span>
      </button>`).join('')}</div>`
      : `<div class="empty small">${c.total ? '아직 연 문서가 없습니다. 아래 탭에서 자료를 열어 보세요.'
          : '자료 목록을 아직 받지 않았습니다.'}</div>`}`;
}

function onTileClick(e) {
  const b = e.target.closest('[data-go]');
  if (b && !b.disabled) { router.go(b.dataset.go); return; }
  const doc = e.target.closest('[data-doc]');
  if (doc) router.go('#/doc/' + encodeURIComponent(doc.dataset.doc));
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
      { ico: '🤖', label: '문서 AI', sub: '자료에 물어보기', go: '#/lib/ai' },
    ],
  },
  work: {
    title: '✍️ 학습지',
    desc: '빈칸을 채우고 채점합니다. 답은 이 기기에 저장됩니다.',
    tiles: [
      { ico: '📝', label: '백지 인출', sub: '과목 → 단원', go: '#/browse?root=recall', count: 'recall' },
      { ico: '🔁', label: '복기 퀴즈', sub: '과목 → 세트', go: '#/browse?root=quiz', count: 'quiz' },
      { ico: '▶️', label: '이어서 풀기', sub: '풀다 만 것', go: '#/work/resume' },
      { ico: '📄', label: '내 답안', sub: '쓴 것 · 보낼 것', go: '#/work/answers' },
    ],
  },
  review: {
    title: '🧠 복습',
    desc: '짧은 시간에 되짚습니다.',
    tiles: [
      { ico: '🗓️', label: '오늘의 복습', sub: '', go: '#/review/today', count: 'due', unit: '장', zero: '오늘은 없음' },
      { ico: '🃏', label: '복습 카드', sub: '가진 카드', go: '#/review/today', count: 'cards', unit: '장', zero: '아직 없음' },
      { ico: '🔘', label: '객관식 시험', sub: '탭만으로', go: '#/review/mcq' },
      { ico: '❌', label: '오답 재시험', sub: '틀린 것만', go: '#/review/wrong' },
    ],
  },
  settings: {
    title: '⚙️ 설정 · 동기화',
    desc: '연결 상태와 앱 설정입니다.',
    tiles: [
      { ico: '🔄', label: '동기화 상태', sub: '', go: '#/settings/sync' },
      { ico: '💾', label: '저장 공간', sub: '', go: '#/settings/storage' },
      { ico: '🎨', label: '표시 · 시험일', sub: '테마 · 글자 · D-day', go: '#/settings/display' },
      { ico: '🤖', label: 'AI 키', sub: '문서 AI 답변용', go: '#/settings/ai' },
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
      <p>${esc(hub.desc)}</p>
    </div>
    <div class="tiles">
      ${hub.tiles.map(t => {
        const n = t.count ? counts[t.count] : 0;
        const sub = t.count ? (n ? `${n}${t.unit || '편'}` : (t.zero || '목록 받는 중')) : t.sub;
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
  // 허브는 하단 탭의 뿌리다 — 돌아갈 곳은 탭이 맡으므로 ← 를 두지 않는다
  shell.render({ title: hub.title.replace(/^\S+\s/, ''), back: false, node: el });
}

function countByKind() {
  const out = {};
  for (const f of catalog.files()) {
    if (classify.isAudio(f.name) || classify.isSystemPath(f.path)) continue;
    const k = classify.classify(f).kind;
    out[k] = (out[k] || 0) + 1;
  }
  // 복습은 문서가 아니라 카드다 — 스토어에서 가져온다
  const rev = get('review');
  out.due = rev.due || 0;
  out.cards = rev.total || 0;
  return out;
}

/* ── 작은 목록 화면 두 개 ──────────────────────────────────────────── */
export async function renderRecent() {
  const list = await recents(30);
  const el = document.createElement('div');
  el.innerHTML = `
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
    <div class="hub-head">
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

/** 내 답안 — 이 기기에 쓴 것과, 아직 PC 로 못 보낸 것. */
export async function renderAnswers() {
  const rows = await myAnswers(50);
  const pend = await outbox.pending();
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="hub-head">
      <p>이 기기에서 푼 학습지입니다. 답은 기기에 남고 PC 로도 넘어갑니다.</p></div>
    <div class="rows">
      <div class="set-row"><span class="k">푼 학습지</span><span class="v">${rows.length}편</span></div>
      <div class="set-row"><span class="k">아직 못 보낸 것</span>
        <span class="v ${pend.length ? 'warn' : 'good'}">${pend.length}건</span></div>
    </div>
    ${rows.length ? `<div class="doc-list">${rows.map(r => `
      <button class="doc-row pressable" data-doc="${esc(r.id)}">
        <span class="doc-name">${esc((r.name || '').replace(/\.html?$/i, ''))}</span>
        <span class="doc-meta">
          <span class="kind">${r.count || 0}칸</span>
          <span class="where">${esc(r.path || '')}</span>
        </span>
      </button>`).join('')}</div>`
      : `<div class="empty">아직 푼 학습지가 없습니다.<br>학습지를 열어 답을 써 보세요.</div>`}`;
  el.addEventListener('click', onListClick);
  shell.render({ title: '내 답안', back: true, node: el });
}
