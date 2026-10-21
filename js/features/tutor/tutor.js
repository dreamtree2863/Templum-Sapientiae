/* tutor.js — 학습 챗봇 화면(#/lib/tutor). 데스크톱 appshell/chat.py 의 폰판.
 *
 *  ┌ [자유 학습|퀴즈|암기 확인]  범위 ▾   ☰ 대화 ┐
 *  │  대화(이스케이프 후 굵게·목록·표·수식만)       │
 *  ├────────────────────────────────────────────┤
 *  │ 🎙 🎧  [입력]                         보내기 │
 *  └────────────────────────────────────────────┘
 *
 *  ‼ AI 를 부르는 버튼은 처리기 **맨 앞**에서 search.ensureAi() — 만료 토큰 갱신 팝업이 터치 안에서 열리게.
 *  ‼ 답에 HTML 을 그대로 넣지 않는다(지어낸 마크업 방지) — md() 가 이스케이프한 뒤 몇 가지만 바꾼다.
 */
import * as shell from '../shell.js';
import * as router from '../../core/router.js';
import { tutor, search, catalog, recents } from '../../data/index.js';
import { VoiceController } from './voice.js';

const esc = shell.escapeHtml;
let chat = null;          // 지금 대화
let pending = null;       // 보내는 중인 내 말
let streamText = '';      // 받는 중인 답
let busy = false;
let lastCtx = {};
let voice = null;
let $el = null;

/* ── 진입 ─────────────────────────────────────────────────────────── */
export async function renderTutor(q = {}) {
  if (!chat || q.new || q.mode || q.topic || q.scope || q.doc) {
    const keep = chat && !q.new ? { mode: chat.mode } : {};
    chat = tutor.newChat({
      mode: q.mode || keep.mode || 'ask',
      scope: q.doc ? 'doc' : q.topic && q.mode !== 'ask' ? 'topic' : (q.scope || 'due'),
      subject: q.subject || '', topic: q.mode !== 'ask' ? (q.topic || '') : '',
      docId: q.doc || '', docTitle: q.doc ? (catalog.byId(q.doc)?.baseTitle || catalog.byId(q.doc)?.name || '') : '',
    });
    pending = null; streamText = '';
    if (q.topic && q.mode === 'ask') setTimeout(() => send(q.topic), 50);    // 문서 AI 에서 넘어온 질문
  }
  const el = document.createElement('div');
  el.className = 'tutor';
  $el = el;
  el.innerHTML = `
    <div class="tutor-head">
      <div class="seg">${Object.entries(tutor.MODES).map(([m, label]) =>
        `<button class="seg-b pressable" data-mode="${m}">${label}</button>`).join('')}</div>
      <div class="tutor-row">
        <select id="t-scope" class="set-input t-scope"></select>
        <button class="more-btn pressable t-mini" data-act="history" aria-label="대화 목록">☰</button>
        <button class="more-btn pressable t-mini" data-act="new" aria-label="새 대화">＋</button>
      </div>
      <div class="t-stats" id="t-stats"></div>
    </div>
    <div class="tutor-log" id="t-log"></div>
    <div class="tutor-hist" id="t-hist" hidden></div>
    <div class="tutor-comp">
      <div class="t-status" id="t-status"></div>
      <div class="tutor-row">
        <button class="more-btn pressable t-mic" data-act="voice" aria-label="음성 대화">🎙</button>
        <button class="more-btn pressable t-mini" data-act="duplex" id="t-duplex" hidden aria-label="이어폰(끼어들기)">🎧</button>
        <textarea id="t-in" class="set-input t-in" rows="1" placeholder="묻거나 답하기 · '퀴즈 내 줘'"></textarea>
        <button class="more-btn primary pressable" data-act="send">보내기</button>
      </div>
    </div>`;
  el.addEventListener('click', onClick);
  el.querySelector('#t-scope').addEventListener('change', onScope);
  const $in = el.querySelector('#t-in');
  $in.addEventListener('input', () => { $in.style.height = 'auto'; $in.style.height = Math.min(140, $in.scrollHeight) + 'px'; });
  shell.render({ title: '학습 챗봇', back: true, node: el });
  syncHead();
  paint();
}

/* ── 머리 ─────────────────────────────────────────────────────────── */
function scopeOptions() {
  const o = [['due', '오늘 복습할 것']].concat(tutor.SUBJECTS.map(s => ['subject:' + s, s]));
  o.push(['topic', chat.scope === 'topic' && chat.topic ? '주제: ' + chat.topic.slice(0, 12) : '주제 정하기…']);
  o.push(['doc', chat.scope === 'doc' && chat.docTitle ? '문서: ' + chat.docTitle.slice(0, 12) : '문서 고르기…']);
  return o;
}
const scopeKey = () => chat.scope === 'subject' ? 'subject:' + chat.subject : chat.scope;

function syncHead() {
  if (!$el) return;
  $el.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === chat.mode));
  const sel = $el.querySelector('#t-scope');
  sel.innerHTML = scopeOptions().map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('');
  sel.value = scopeKey();
  const st = tutor.stats(chat);
  $el.querySelector('#t-stats').textContent = st.n ? `${st.n}문항 · 정확 ${st.ok} · 부분 ${st.part} · 미흡 ${st.miss}` : '';
}

async function onScope(e) {
  const v = e.target.value;
  tutor.resetScopeCache(chat);
  if (v.startsWith('subject:')) { chat.scope = 'subject'; chat.subject = v.slice(8); }
  else if (v === 'topic') {
    const t = prompt('어떤 주제로 공부할까요? (예: 자위권, 구축효과, 세력균형)', chat.topic || '');
    if (t && t.trim()) { chat.scope = 'topic'; chat.topic = t.trim(); chat.subject = ''; }
  } else if (v === 'doc') {
    await pickDoc();
  } else { chat.scope = 'due'; chat.subject = ''; }
  if (chat.turns.length) tutor.saveChat(chat);
  syncHead(); paint();
}

async function pickDoc() {
  const recent = await recents(12);
  const names = recent.map((r, i) => `${i + 1}. ${r.name.replace(/\.html?$/i, '')}`).join('\n');
  const a = prompt(`공부할 문서 — 번호(최근 본 문서) 또는 이름 일부:\n${names}`, '');
  if (!a || !a.trim()) return;
  let f = null;
  const n = Number(a.trim());
  if (n >= 1 && n <= recent.length) f = catalog.byId(recent[n - 1].id);
  else f = search.rank(a.trim(), { limit: 1 })[0] || null;
  if (!f) { shell.toast('문서를 찾지 못했습니다'); return; }
  chat.scope = 'doc'; chat.docId = f.id; chat.docTitle = (f.baseTitle || f.name).replace(/\.html?$/i, '');
}

/* ── 그리기 ───────────────────────────────────────────────────────── */
function emptyHtml() {
  const what = chat.scope === 'due' && chat.mode !== 'ask' ? '오늘 복습할 것(복습 카드)' : tutor.scopeLabel(chat);
  const chips = (pairs) => `<div class="chips t-chips">${pairs.map(([l, t]) =>
    `<button class="chip pressable" data-say="${esc(t)}">${esc(l)}</button>`).join('')}</div>`;
  if (chat.mode === 'quiz') return `<div class="t-empty"><div class="k">EXERCITATIO</div><h2>퀴즈</h2>
      <p>범위: ${esc(what)}<br>OX·객관식·빈칸·단답·서술 — 형식과 개수를 말하면 그대로 냅니다. 판정은 복습 일정에 반영됩니다.</p>
      ${chips([['시작하기', '퀴즈를 시작해 줘.'], ['OX 5문제', 'OX 5문제를 한꺼번에 내 줘.'], ['객관식 3문제', '객관식 3문제를 한꺼번에 내 줘.'],
               ['빈칸', '빈칸 채우기 문제로 내 줘.'], ['단답 연속', '단답형으로 하나씩 계속 내 줘.'], ['답안 목차', '답안 목차를 꺼내는 문제 위주로 내 줘.']])}</div>`;
  if (chat.mode === 'recall') return `<div class="t-empty"><div class="k">MEMORIA</div><h2>암기 확인</h2>
      <p>범위: ${esc(what)}<br>단서 없이 꺼내 보면 자료와 대조해 ✓재현 △부분 ✗누락 ⚠부정확 으로 짚고, 놓친 것만 다시 묻습니다.</p>
      ${chips([['시작하기', '암기 확인을 시작해 줘.'], ['정의·요건', '핵심 개념의 정의와 요건을 외웠는지 확인해 줘.'],
               ['판례 요지', '판례 요지(사실·쟁점·판시)를 외웠는지 확인해 줘.'], ['목차 통째로', '답안 목차를 통째로 백지 인출하게 해 줘.']])}</div>`;
  return `<div class="t-empty"><div class="k">STUDIUM</div><h2>자유 학습</h2>
      <p>무엇이든 물어보세요 — 설명·정리·비교·답안 목차. 원하면 즉석 퀴즈나 암기 확인도 합니다.<br>
      내 자료에서 찾아 근거로 답합니다. 🎙 를 누르면 말로 대화합니다.</p>
      ${chips([['헷갈리는 개념 비교', '헷갈리기 쉬운 개념 쌍을 비교표로 보여 줘.'], ['간단한 퀴즈', '간단한 퀴즈 3문제 내 줘.'],
               ['외운 거 확인', '내가 외운 걸 말해 볼 테니 자료와 대조해서 확인해 줘.']])}</div>`;
}

function paint() {
  const log = $el?.querySelector('#t-log');
  if (!log) return;
  const rows = chat.turns.map(t => t.role === 'user'
    ? `<div class="msg u"><div class="b">${esc(t.text)}</div></div>`
    : `<div class="msg m"><div class="b">${md(t.text.replace(tutor.GRADE_RE, ''))}</div>
        ${t.note ? `<div class="t-note">${esc(t.note)}</div>` : ''}
        ${t.check ? `<div class="t-check${/틀림 [1-9]|불확실 [1-9]|실패/.test(t.check) ? ' warn' : ''}">${esc(t.check).replace(/\n/g, '<br>')}</div>` : ''}</div>`);
  if (pending != null) {
    rows.push(`<div class="msg u"><div class="b">${esc(pending)}</div></div>`);
    rows.push(`<div class="msg m pending"><div class="b" id="t-stream">${streamText ? md(streamText) : '<span class="dots"><i></i><i></i><i></i></span>'}</div></div>`);
  }
  log.innerHTML = rows.length ? rows.join('') : emptyHtml();
  typeset(log);
  scrollEnd();
}

let streamTimer = 0;
function paintStream() {
  if (streamTimer) return;
  streamTimer = setTimeout(() => {
    streamTimer = 0;
    const b = $el?.querySelector('#t-stream');
    if (b) { b.innerHTML = md(streamText.replace(/\[\[GRADE[^\]]*\]?\]?\s*$/, '').replace(tutor.GRADE_RE, '')); scrollEnd(); }
  }, 110);
}

function scrollEnd() { const m = shell.main(); if (m) m.scrollTop = m.scrollHeight; window.scrollTo(0, document.body.scrollHeight); }
function setStatus(t) { const s = $el?.querySelector('#t-status'); if (s) s.textContent = t || ''; }

/** 아주 작은 마크다운 — 먼저 이스케이프하고 굵게·기울임·제목·목록·표·인라인 코드만 바꾼다. */
function md(text) {
  const lines = esc(String(text || '')).split('\n');
  const out = [];
  let list = null, table = null;
  const inline = (s) => s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const flush = () => {
    if (list) { out.push(`<${list.t}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.t}>`); list = null; }
    if (table) {
      const rows = table.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r));
      out.push('<div class="t-table"><table>' + rows.map((r, i) => '<tr>' + r.replace(/^\s*\||\|\s*$/g, '').split('|')
        .map(c => i === 0 ? `<th>${inline(c.trim())}</th>` : `<td>${inline(c.trim())}</td>`).join('') + '</tr>').join('') + '</table></div>');
      table = null;
    }
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(l)) { if (list) flush(); (table = table || []).push(l); continue; }
    if (table) flush();
    let m;
    if ((m = /^\s*[-*•]\s+(.*)$/.exec(l))) { if (!list || list.t !== 'ul') { flush(); list = { t: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(l))) { if (!list || list.t !== 'ol') { flush(); list = { t: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    flush();
    if ((m = /^#{1,4}\s+(.*)$/.exec(l))) { out.push(`<h4>${inline(m[1])}</h4>`); continue; }
    if (/^-{3,}$/.test(l.trim())) { out.push('<hr>'); continue; }
    out.push(l.trim() ? `<p>${inline(l)}</p>` : '');
  }
  flush();
  return out.join('');
}

/* 수식 — 답에 \( 가 있을 때만 MathJax 를 한 번 싣는다 */
let mjLoading = null;
function typeset(el) {
  if (!/\\\(|\\\[/.test(el.textContent || '')) return;
  if (window.MathJax?.typesetPromise) { MathJax.typesetPromise([el]).catch(() => {}); return; }
  if (!mjLoading) {
    window.MathJax = { startup: { typeset: false }, tex: { inlineMath: [['\\(', '\\)']] }, chtml: { fontURL: './vendor/mathjax/es5/output/chtml/fonts/woff-v2' } };
    mjLoading = new Promise((res) => {
      const s = document.createElement('script');
      s.src = './vendor/mathjax/es5/tex-mml-chtml.js'; s.async = true; s.onload = res; s.onerror = res;
      document.head.appendChild(s);
    });
  }
  mjLoading.then(() => window.MathJax?.startup?.promise).then(() => window.MathJax?.typesetPromise?.([el])).catch(() => {});
}

/* ── 보내기 ───────────────────────────────────────────────────────── */
async function send(textArg) {
  if (busy) return;
  const $in = $el?.querySelector('#t-in');
  let text = (typeof textArg === 'string' ? textArg : $in?.value || '').trim();
  if (!text) {
    const start = { quiz: '퀴즈를 시작해 줘.', recall: '암기 확인을 시작해 줘.' }[chat.mode];
    if (start && !chat.turns.length) text = start; else return;
  }
  if (voice?.active()) { if ($in) $in.value = ''; voice.sendText(text); return; }
  try { await search.ensureAi(); }                      // ‼ 맨 먼저(터치 안) — 만료면 여기서 갱신
  catch (e) { shell.toast(e.message, 'error'); return; }
  busy = true;
  if ($in) { $in.value = ''; $in.style.height = 'auto'; }
  pending = text; streamText = '';
  paint();
  try {
    const r = await tutor.runTurn(chat, text, {
      onDelta: (s) => { streamText = s; paintStream(); },
      status: setStatus,
    });
    lastCtx = r.ctx || {};
    pending = null; streamText = '';
    setStatus('');
    syncHead(); paint();
    factCheckLast(lastCtx, 300);
  } catch (e) {
    pending = null; streamText = '';
    if ($in) $in.value = text;
    setStatus('');
    paint();
    shell.toast(e.message, 'error');
  }
  busy = false;
}

async function factCheckLast(ctx, minLen) {
  const t = chat.turns[chat.turns.length - 1];
  if (!t || t.role !== 'model' || !tutor.needsFactCheck(t.text, minLen)) return;
  t.check = '🔎 사실 점검 중… (Google 검색으로 판례·연도·조문·수치 대조)';
  paint();
  try { t.check = await tutor.factCheck(t.text, ctx); }
  catch (e) { t.check = '🔎 사실 점검 실패: ' + String(e.message).slice(0, 100); }
  if (!t.check) delete t.check;
  await tutor.saveChat(chat);
  if (chat.turns.includes(t)) paint();
}

/* ── 음성 ─────────────────────────────────────────────────────────── */
async function toggleVoice(btn) {
  if (voice?.active()) { voice.stop('🎙 음성 대화를 끝냈습니다.'); return; }
  try { await search.ensureAi(); } catch (e) { shell.toast(e.message, 'error'); return; }
  btn.classList.add('on');
  setStatus('🎙 자료 준비 중…');
  let vmodel = '';
  voice = new VoiceController({
    status: setStatus,
    userPartial: (t) => { pending = t || '🎙 …'; paint(); if (vmodel) { const b = $el?.querySelector('#t-stream'); if (b) b.innerHTML = md(vmodel); } },
    modelPartial: (t) => { vmodel = t; if (pending == null) { pending = '🎙 …'; paint(); } streamText = t; paintStream(); },
    turn: async (u, m, interrupted) => {
      const now = Date.now();
      if (u) chat.turns.push({ role: 'user', text: u, ts: now, voice: true });
      if (m) chat.turns.push({ role: 'model', text: m + (interrupted ? ' …(끊김)' : ''), ts: now, voice: true, note: '🎙 음성 대화' });
      pending = null; streamText = ''; vmodel = '';
      await tutor.saveChat(chat);
      paint();
      if (m) factCheckLast({ ...lastCtx, searchText: voice?.lastSearch || lastCtx.searchText || '' }, 60);
    },
    stopped: (reason) => {
      pending = null; streamText = '';
      btn.classList.remove('on');
      const d = $el?.querySelector('#t-duplex'); if (d) { d.hidden = true; d.classList.remove('on'); }
      paint();
      setStatus(reason || '');
    },
    level: () => {},
  });
  try {
    lastCtx = await tutor.voiceContext(chat, setStatus);
    const history = chat.turns.slice(-10).map(t => ({ role: t.role, text: t.text.replace(tutor.GRADE_RE, '') }));
    await voice.start(tutor.buildSystem(chat, lastCtx), history);
    const d = $el?.querySelector('#t-duplex'); if (d) d.hidden = false;
  } catch (e) {
    btn.classList.remove('on');
    setStatus('');
    shell.toast(e.message, 'error');
    voice = null;
  }
}

/* ── 대화 목록 ────────────────────────────────────────────────────── */
async function showHistory() {
  const h = $el.querySelector('#t-hist');
  if (!h.hidden) { h.hidden = true; return; }
  const list = await tutor.listChats();
  h.innerHTML = list.length ? list.map(r => `
      <div class="t-hrow"><button class="doc-row pressable" data-open="${esc(r.id)}">
        <span class="doc-name">${esc(r.title)}</span>
        <span class="doc-meta"><span class="where">${new Date(r.updated).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${r.stats?.n ? ` · ${r.stats.n}문항 정확 ${r.stats.ok}` : ''}</span></span>
      </button><button class="more-btn t-mini" data-del="${esc(r.id)}" aria-label="삭제">✕</button></div>`).join('')
    : '<p class="set-note">저장된 대화가 없습니다.</p>';
  h.hidden = false;
}

/* ── 클릭 ─────────────────────────────────────────────────────────── */
async function onClick(e) {
  const say = e.target.closest('[data-say]');
  if (say) { send(say.dataset.say); return; }
  const mode = e.target.closest('[data-mode]');
  if (mode) { chat.mode = mode.dataset.mode; if (chat.turns.length) tutor.saveChat(chat); syncHead(); paint(); return; }
  const op = e.target.closest('[data-open]');
  if (op) {
    if (voice?.active()) voice.stop();
    const c = await tutor.loadChat(op.dataset.open);
    if (c) { chat = c; pending = null; streamText = ''; }
    $el.querySelector('#t-hist').hidden = true;
    syncHead(); paint();
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    if (!confirm('이 대화를 지울까요?')) return;
    await tutor.deleteChat(del.dataset.del);
    if (chat.id === del.dataset.del) chat = tutor.newChat({ mode: chat.mode });
    $el.querySelector('#t-hist').hidden = true;
    showHistory(); syncHead(); paint();
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'send') send();
  else if (b.dataset.act === 'voice') toggleVoice(b);
  else if (b.dataset.act === 'duplex') { b.classList.toggle('on'); voice?.setFullDuplex(b.classList.contains('on')); shell.toast(b.classList.contains('on') ? '이어폰 — 튜터가 말하는 도중에도 끼어들 수 있습니다' : '스피커 — 튜터가 말하는 동안 마이크를 쉽니다'); }
  else if (b.dataset.act === 'history') showHistory();
  else if (b.dataset.act === 'new') {
    if (voice?.active()) voice.stop();
    chat = tutor.newChat({ mode: chat.mode, scope: chat.scope, subject: chat.subject, topic: chat.topic, docId: chat.docId, docTitle: chat.docTitle });
    pending = null; streamText = '';
    syncHead(); paint();
  }
}

/** 다른 화면으로 나가면 음성은 끈다(숨은 마이크 방지). */
export function leave() { if (voice?.active()) voice.stop(); }
