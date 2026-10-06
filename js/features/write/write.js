/* write.js — 폰에서 논술 답안·목차를 쓴다 (학습지 너머).
 *
 *  #/write/<문제 파일 id>?mode=answer   시험 답안 — 시간 재기·분량 목표, 다 쓰면 PC 로 보내 PC 에서 채점
 *  #/write/<문제 파일 id>?mode=toc      목차 퀴즈 — 폰에서 바로 채점(grade-toc.js, PC 와 같은 셈)·⚖ 항변,
 *                                       결과·고른 논점을 PC 로 보내면 PC 가 학습 이력·복습 카드로 남긴다
 *
 *  편집기는 데스크톱과 **같은 파일**이다(vendor/rich_answer.js · sketch_pad.js · graph_editor.js) —
 *  개요 번호(⇤⇥↵번호 단추), 📈 그래프 그리기, 🖍 도식, 표, 기호. 폰에선 touch:true 로 단추를 띄운다.
 *
 *  ‼ 쓰는 중에 앱이 죽어도 남는다 — 바뀔 때마다 IndexedDB(state: write:<id>:<mode>)에 적는다.
 *  ‼ PC 로 보내는 것은 사건(kind:'essay')이다 — 올라간 뒤에만 큐에서 지운다(data/uplink.js).
 *    PC 짝: study_manager/core/mobile_essays.py (PC exe 가 그 처리기를 알아야 받는다).
 */
import * as shell from '../shell.js';
import * as router from '../../core/router.js';
import * as idb from '../../core/idb.js';
import * as log from '../../core/log.js';
import { get } from '../../core/store.js';
import { catalog, classify, docContent, docRules, outbox, uplink, search, gradeToc } from '../../data/index.js';
import { inject } from '../viewer/inject.js';

const esc = shell.escapeHtml;
const MODE_LABEL = { answer: '답안', toc: '목차' };
let cur = null;

/* ── 편집기 스크립트(고전 스크립트 — window.RichAnswer 등) 한 번만 싣기 ── */
const loaded = new Map();
function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => res();
      s.onerror = () => { loaded.delete(src); rej(new Error(src + ' 을 싣지 못했습니다')); };
      document.head.appendChild(s);
    }));
  }
  return loaded.get(src);
}
async function ensureEditor() {
  await loadScript('./vendor/sketch_pad.js');
  await loadScript('./vendor/graph_editor.js');
  await loadScript('./vendor/rich_answer.js');
}

const draftKey = (id, mode) => `write:${id}:${mode}`;
const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
};

/* ── 열기 ─────────────────────────────────────────────────────────── */
export async function open(fileId, params = {}) {
  close();
  const mode = params.mode === 'toc' ? 'toc' : 'answer';
  const file = catalog.byId(fileId);
  if (!file) {
    shell.render({ title: '답안 쓰기', back: true, html: '<div class="empty">문제를 찾지 못했습니다.<br>목록을 새로고침해 보세요.</div>' });
    return;
  }
  const info = classify.classify(file);
  const sib = gradeToc.siblingsOf(file);
  const draft = await idb.get('state', draftKey(file.id, mode)).catch(() => null);

  const el = document.createElement('div');
  el.className = 'write-wrap';
  el.innerHTML = `
    <div class="write-bar">
      <span class="write-mode">${mode === 'toc' ? '📑 목차 퀴즈' : '📝 답안'}</span>
      ${mode === 'answer' ? `<select id="w-dur" title="시간 재기">
          <option value="0">⏱ 시간 안 잼</option>
          ${[30, 45, 50, 60, 90, 120].map(m => `<option value="${m}">${m}분</option>`).join('')}
        </select>` : ''}
      <span id="w-clock" class="write-clock"></span>
      <span id="w-count" class="write-count"></span>
    </div>
    <div class="write-problem" id="w-prob">
      <button class="write-prob-toggle" id="w-prob-toggle">문제 접기 ▲</button>
      <div class="write-prob-body"><iframe id="w-frame" title="문제"></iframe></div>
    </div>
    <div class="write-editor-host"><div id="w-ed" class="write-editor"></div></div>
    <div class="write-actions">
      <span id="w-saved" class="write-saved"></span>
      ${mode === 'toc'
        ? `<select id="w-crit">
             ${sib.rubric ? '<option value="rubric">📏 채점기준</option>' : ''}
             ${sib.toc ? '<option value="toc">📑 모범 목차</option>' : ''}
           </select>
           <button class="btn-primary pressable" id="w-grade">🧮 채점</button>`
        : `<button class="btn-primary pressable" id="w-send">📤 PC로 보내기</button>`}
    </div>
    <div id="w-result" class="write-result" hidden></div>`;
  shell.render({ title: info.baseTitle || file.name, back: true, node: el });
  document.body.classList.add('writing');

  cur = { file, mode, info, sib, el, ed: null, elapsed: draft?.elapsedSec || 0,
          startedAt: draft?.startedAt || Date.now(), durationMin: draft?.durationMin || 0,
          tick: null, saveT: null, targetPts: 0, result: null };

  loadProblem(el.querySelector('#w-frame'), file).catch(e => log.warn('write', '문제 표시 실패', e));
  el.querySelector('#w-prob-toggle').addEventListener('click', () => {
    const p = el.querySelector('#w-prob');
    p.classList.toggle('folded');
    el.querySelector('#w-prob-toggle').textContent = p.classList.contains('folded') ? '문제 펴기 ▼' : '문제 접기 ▲';
  });

  try {
    await ensureEditor();
  } catch (e) {
    el.querySelector('#w-ed').textContent = '편집기를 싣지 못했습니다 — 연결 후 다시 열어 주세요.';
    return;
  }
  if (!cur || cur.el !== el) return;
  const edEl = el.querySelector('#w-ed');
  edEl.setAttribute('data-placeholder', mode === 'toc'
    ? 'Ⅰ. 단추로 시작 → ↵번호 로 다음 번호, ⇥ 내리기, ⇤ 올리기. 문제만 보고 답안 목차를 세웁니다.'
    : '답안을 씁니다. 개요 번호(Ⅰ. 1. (1)…)·📈 그래프·🖍 도식·▦ 표를 쓸 수 있습니다.');
  cur.ed = window.RichAnswer.upgrade(edEl, {
    touch: true,
    outlineMode: mode === 'toc' ? 'continue' : undefined,
    tools: mode === 'toc'
      ? ['outline', 'symbols', 'graph', 'sketch', 'table']
      : ['outline', 'graph', 'sketch', 'table', 'symbols', 'format', 'image', 'nav'],
    onChange: () => { paintCount(); scheduleSave(); },
  });
  if (draft?.html) {
    cur.ed.setContent(draft.html);
    shell.toast(`쓰던 ${MODE_LABEL[mode]}을 이어서 씁니다`, 'info');
  }

  // 시간 · 분량
  const dur = el.querySelector('#w-dur');
  if (dur) {
    dur.value = String(cur.durationMin || 0);
    dur.addEventListener('change', () => { cur.durationMin = Number(dur.value) || 0; cur.warned = false; paintClock(); scheduleSave(); });
  }
  cur.tick = setInterval(() => {
    if (document.visibilityState !== 'visible' || !cur) return;
    cur.elapsed += 1;
    paintClock();
    if (cur.elapsed % 15 === 0) scheduleSave();
  }, 1000);
  paintClock();
  paintCount();
  if (mode === 'answer' && sib.rubric) {
    gradeToc.loadRubric(sib.rubric).then(r => { if (cur) { cur.targetPts = gradeToc.totalPoints(r); paintCount(); } })
      .catch(() => {});
  }

  el.querySelector('#w-send')?.addEventListener('click', sendAnswer);
  el.querySelector('#w-grade')?.addEventListener('click', runGrade);
  if (mode === 'toc' && !sib.rubric && !sib.toc) {
    el.querySelector('#w-grade').disabled = true;
    el.querySelector('#w-saved').textContent = '이 문제는 채점기준·목차본이 없어 채점할 수 없습니다';
  }
}

export function close() {
  document.body.classList.remove('writing');
  if (!cur) return;
  clearInterval(cur.tick);
  clearTimeout(cur.saveT);
  saveNow();
  cur = null;
}

/* 문제 — 목차·답안이 섞인 파일이면 .question 만 보인다(모범 답이 새지 않게) */
async function loadProblem(frame, file) {
  const d = await docContent.fetchDoc(file);
  let html = await d.blob.text();
  const plan = docRules.planFor(file.path + '/' + file.name, d.head);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('.toc, .answer, .source-note, script').forEach(n => n.remove());
  html = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  frame.addEventListener('load', () => {
    try {
      const ui = get('ui');
      inject(frame.contentDocument, { ...plan, mathjax: true }, { theme: ui.theme, textScale: ui.textScale });
    } catch (e) { log.warn('write', '문제 꾸미기 실패', e); }
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }, { once: true });
  frame.src = url;
}

function paintClock() {
  if (!cur) return;
  const c = cur.el.querySelector('#w-clock');
  if (!c) return;
  if (cur.durationMin) {
    const left = cur.durationMin * 60 - cur.elapsed;
    c.textContent = left >= 0 ? `⏳ ${fmt(left)}` : `⏰ +${fmt(-left)}`;
    c.classList.toggle('over', left < 0);
    c.classList.toggle('near', left >= 0 && left <= 300);
    if (left === 0 && !cur.warned) {
      cur.warned = true;
      shell.toast('시간이 다 됐습니다 — 계속 쓸 수는 있습니다(시간 초과로 기록)', 'error', 5000);
      try { navigator.vibrate?.([200, 100, 200]); } catch (e) {}
    }
  } else {
    c.textContent = `⏱ ${fmt(cur.elapsed)}`;
    c.classList.remove('over', 'near');
  }
}

function paintCount() {
  if (!cur?.ed) return;
  const n = (cur.ed.getText() || '').replace(/\s+$/, '').length;
  const c = cur.el.querySelector('#w-count');
  if (cur.mode === 'toc') {
    const hs = cur.ed.getHeadings();
    c.textContent = `목차 ${hs.length}줄`;
    return;
  }
  if (cur.targetPts > 0) {        // 배점 10점당 700~800자 (PC 시험 응시와 같은 잣대)
    const lo = cur.targetPts * 70, hi = cur.targetPts * 80;
    c.textContent = `${n.toLocaleString()} / ${lo.toLocaleString()}~${hi.toLocaleString()}자`;
    c.className = 'write-count' + (n >= lo && n <= hi * 1.1 ? ' ok' : n > hi * 1.1 ? ' over' : '');
  } else {
    c.textContent = `${n.toLocaleString()}자`;
  }
}

function scheduleSave() {
  if (!cur) return;
  clearTimeout(cur.saveT);
  cur.saveT = setTimeout(saveNow, 800);
}
function saveNow() {
  if (!cur?.ed) return;
  const c = cur;
  idb.put('state', draftKey(c.file.id, c.mode), {
    html: c.ed.getHTML(), elapsedSec: c.elapsed, startedAt: c.startedAt,
    durationMin: c.durationMin, savedAt: Date.now(), name: c.file.name, path: c.file.path,
  }).then(() => {
    const s = c.el.querySelector('#w-saved');
    if (s && !c.result) s.textContent = '이 기기에 저장됨 ' + new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }).catch(e => log.warn('write', '임시 저장 실패', e));
}

function baseEvent(extra = {}) {
  const c = cur;
  const text = c.ed.getOutlineText();
  return {
    kind: 'essay', mode: c.mode,
    docId: c.file.id, name: c.file.name, path: c.file.path,
    html: c.ed.getHTML(), text,
    chars: (c.ed.getText() || '').trim().length,
    startedAt: c.startedAt, finishedAt: Date.now(),
    elapsedSec: c.elapsed, durationMin: c.durationMin || 0,
    timedOut: !!(c.durationMin && c.elapsed > c.durationMin * 60),
    ...extra,
  };
}

async function enqueueAndFlush(ev, okMsg) {
  await outbox.enqueue(ev);
  const r = await uplink.flush({ silent: true }).catch(() => ({}));
  shell.toast(r?.sent ? okMsg + ' — PC 로 보냈습니다' : okMsg + ' — 연결되면 PC 로 보냅니다', 'ok', 4000);
}

/* ── 답안: PC 로 보내기 ─────────────────────────────────────────────── */
async function sendAnswer() {
  const c = cur;
  if (!c?.ed || c.ed.isEmpty()) { shell.toast('답안이 비어 있습니다', 'error'); return; }
  if (!confirm('이 답안을 PC 로 보낼까요?\nPC 의 채점 화면 › 📱 폰 답안 에서 불러와 채점합니다.')) return;
  try {
    await enqueueAndFlush(baseEvent(), '답안을 담았습니다');
    await idb.put('state', `write-sent:${c.file.id}:answer`, { html: c.ed.getHTML(), at: Date.now() }).catch(() => {});
    await idb.del('state', draftKey(c.file.id, 'answer')).catch(() => {});
    c.ed.clear();
    c.elapsed = 0; c.startedAt = Date.now();
    router.back();
  } catch (e) {
    shell.toast('보내지 못했습니다: ' + (e.message || e), 'error');
  }
}

/* ── 목차: 폰에서 채점 → 결과 · ⚖ 항변 · 복습에 넣을 논점 → PC 로 ───────── */
async function runGrade() {
  const c = cur;
  if (!c?.ed || c.ed.isEmpty()) { shell.toast('목차가 비어 있습니다', 'error'); return; }
  if (!search.hasKey()) { shell.toast('AI 키가 없습니다 — 설정 › AI 키', 'error'); router.go('#/settings/ai'); return; }
  const crit = c.el.querySelector('#w-crit')?.value || (c.sib.rubric ? 'rubric' : 'toc');
  const btn = c.el.querySelector('#w-grade');
  const status = c.el.querySelector('#w-saved');
  btn.disabled = true;
  try {
    const res = await gradeToc.grade({
      criterion: crit, rubricFile: c.sib.rubric, tocFile: c.sib.toc, subject: c.sib.subject,
      outline: c.ed.getOutlineText(), onProgress: (m) => { status.textContent = m; },
    });
    if (cur !== c) return;
    c.result = res;
    status.textContent = '';
    renderResult();
  } catch (e) {
    status.textContent = '';
    shell.toast(e.message || '채점 실패', 'error', 5000);
  } finally { btn.disabled = false; }
}

const VERDICT = { yes: ['✅', '반영', 'v-yes'], partial: ['△', '부분', 'v-partial'], no: ['❌', '누락', 'v-no'] };

function renderResult() {
  const c = cur, res = c.result;
  const box = c.el.querySelector('#w-result');
  box.hidden = false;
  const color = res.score >= 80 ? 'ok' : res.score >= 60 ? 'mid' : 'low';
  const groups = gradeToc.reviewGroups(res);
  const breakdown = res.criterion === 'rubric' ? (res.breakdown || []).map((q, qi) => `
      <div class="wr-q"><b>${esc(q.id)} ${esc(q.title || '')}</b> <span class="wr-pts">${q.earned} / ${q.max}점</span></div>
      ${(q.items || []).map((it, ii) => {
        const v = VERDICT[it.verdict] || VERDICT.no;
        return `<div class="wr-item ${v[2]}">
          <div><span class="wr-v">${v[0]} ${v[1]}</span> <span class="wr-cat">${esc(it.category)} ${it.earned}/${it.points}</span></div>
          <div class="wr-crit">${esc(it.criterion)}</div>
          ${it.matched ? `<div class="wr-sub">↳ 내 목차: ${esc(it.matched)}</div>` : ''}
          ${it.note ? `<div class="wr-sub">${esc(it.note)}</div>` : ''}
          ${it.appeal ? `<div class="wr-appeal">⚖ 항변: ${esc(it.appeal.argument || '(근거 없이)')}<br>→ ${esc(it.appeal.result)}</div>` : ''}
          ${it.verdict !== 'yes' && !it.appeal ? `<button class="wr-appeal-btn" data-q="${qi}" data-i="${ii}">⚖ 항변</button>` : ''}
        </div>`;
      }).join('')}`).join('') : `
      <div class="wr-q"><b>누락한 항목 ${(res.missing || []).length}</b></div>
      ${(res.missing || []).map(m => `<div class="wr-item v-no"><div class="wr-crit">${esc(m)}</div></div>`).join('')}`;
  box.innerHTML = `
    <div class="wr-head">
      <div class="wr-score ${color}">${res.score}점</div>
      <div>${res.criterion === 'rubric' ? `배점 ${res.points_earned} / ${res.points_max}점` : '모범 목차 대비'}
        <div class="wr-summary">${esc(res.summary || '')}</div></div>
    </div>
    ${breakdown}
    ${groups.length ? `<div class="wr-q"><b>🧠 복습에 넣을 논점</b> <span class="wr-pts">PC 로 보내면 '오늘의 복습'에 카드로</span></div>
      ${groups.map((g, gi) => `<div class="wr-group"><div class="wr-sub"><b>${esc(g.qid || '전체')} ${esc(g.qtitle)}</b></div>
        ${g.items.map((it, ii) => `<label class="wr-check"><input type="checkbox" data-g="${gi}" data-i="${ii}" ${it.checked ? 'checked' : ''}>
          <span>${esc(it.text)} <i>${esc(it.tag)}</i></span></label>`).join('')}</div>`).join('')}` : ''}
    <div class="wr-actions">
      <button class="pressable" id="wr-again">✏️ 고쳐 쓰기</button>
      <button class="btn-primary pressable" id="wr-send">📤 PC로 보내기 (이력·복습)</button>
    </div>`;
  box._groups = groups;
  box.querySelectorAll('.wr-appeal-btn').forEach(b => b.addEventListener('click', () => appeal(+b.dataset.q, +b.dataset.i)));
  box.querySelector('#wr-again').addEventListener('click', () => {
    box.hidden = true; c.result = null; c.ed.focus();
  });
  box.querySelector('#wr-send').addEventListener('click', sendToc);
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ⚖ 항변 — 그 논점 하나만 다시 본다(PC 의 목차 항변과 같은 규칙: 내 목차 원문에 근거가 있을 때만 바꾼다) */
async function appeal(qi, ii) {
  const c = cur, res = c?.result;
  const q = res?.breakdown?.[qi], it = q?.items?.[ii];
  if (!it) return;
  const argument = prompt(`'${it.criterion}' 판정(${VERDICT[it.verdict][1]})에 항변합니다.\n내 목차의 어느 항목이 이 논점을 세운 것인지 적어 주세요(비워도 됩니다):`);
  if (argument === null) return;
  const rubItem = res.rubric?.questions?.[qi]?.items?.[ii] || {};
  const status = c.el.querySelector('#w-saved');
  status.textContent = '⚖ 다시 보는 중…';
  try {
    const r = await search.askJson(appealPrompt(res.rubric?.subject || c.sib.subject, q.id, it, rubItem, argument, c.ed.getOutlineText()), { maxOutputTokens: 2048 });
    const nv = ['yes', 'partial', 'no'].includes(r.verdict) ? r.verdict : it.verdict;
    const old = it.verdict;
    it.appeal = { argument: argument.trim(), from: old, to: nv, explanation: r.explanation || '',
                  result: (nv !== old ? `${VERDICT[old][1]} → ${VERDICT[nv][1]}` : `원판정 유지`) + (r.explanation ? ' — ' + r.explanation : '') };
    if (nv !== old) { it.verdict = nv; recompute(res); }
    status.textContent = '';
    renderResult();
  } catch (e) {
    status.textContent = '';
    shell.toast(e.message || '항변 실패', 'error', 5000);
  }
}

export function appealPrompt(subject, qid, it, rubItem, argument, outline) {
  return `당신은 ${subject || '논술'} 답안의 *목차(개요)* 상급 채점관입니다. 1차 판정의 한 논점에 수험생이 항변했습니다. 그 논점만 독립적으로 다시 판정하세요.\n`
    + '★ 규칙:\n'
    + '1) 수험생 주장에 끌려가지 말 것 — 학생 목차 *원문* 에 그 논점을 세운 항목이 실제로 있을 때만 판정을 올린다.\n'
    + '2) 재판정은 양방향이다 — 1차가 후했으면 내린다.\n'
    + "3) 인접하지만 다른 개념·이론·학자·판례·조문은 동치가 아니다('주의' 란 반영).\n"
    + '출력 JSON 한 개만: {"verdict":"yes|partial|no","explanation":"판단 근거 1~2문장 (학생 목차 원문 인용)"}\n\n'
    + `=== 논점 (${qid}) ===\n기준: ${it.criterion}\n배점: ${it.points}점 (${it.category})\n`
    + (rubItem.details ? `포함 요소: ${rubItem.details}\n` : '') + (rubItem.caution ? `주의: ${rubItem.caution}\n` : '')
    + `1차 판정: ${it.verdict}${it.note ? ' — ' + it.note : ''}\n`
    + (argument.trim() ? `\n=== 수험생의 항변 ===\n${argument.slice(0, 2000)}\n` : '')
    + `\n=== 학생 목차 전문 ===\n${outline}\n`;
}

function recompute(res) {
  const RATE = { yes: 1, partial: 0.5, no: 0 };
  let ea = 0, ma = 0;
  const covered = [], missing = [];
  for (const q of res.breakdown) {
    let qe = 0, qm = 0;
    for (const it of q.items) {
      it.earned = it.points * RATE[it.verdict];
      if (it.category !== '가점') qm += it.points;
      qe += it.earned;
      const label = `[${q.id}] ${it.criterion} (${it.points}점)`;
      if (it.verdict === 'yes') covered.push(label);
      else if (it.verdict === 'partial') missing.push('△ 부분 — ' + label);
      else if (it.category !== '가점') missing.push(label);
    }
    if (qm) qe = Math.min(qe, qm);
    q.earned = Math.round(qe * 10) / 10; q.max = Math.round(qm * 10) / 10;
    ea += qe; ma += qm;
  }
  res.points_earned = Math.round(ea * 10) / 10; res.points_max = Math.round(ma * 10) / 10;
  res.score = ma ? Math.round(100 * ea / ma) : 0;
  res.covered = covered; res.missing = missing;
}

async function sendToc() {
  const c = cur, res = c?.result;
  if (!res) return;
  const box = c.el.querySelector('#w-result');
  const groups = (box._groups || []).map((g, gi) => ({
    qid: g.qid, qtitle: g.qtitle,
    items: g.items.filter((_, ii) => box.querySelector(`input[data-g="${gi}"][data-i="${ii}"]`)?.checked).map(x => x.text),
  })).filter(g => g.items.length);
  const base = c.info.baseTitle.replace(/\s+/g, '');
  const review_groups = groups.map(g => (g.qid && base.endsWith(g.qid.replace(/\s+/g, ''))) ? { ...g, qid: '' } : g);
  const grading = { ...res };
  delete grading.rubric;            // 채점기준 원문은 PC 에 이미 있다
  delete grading.model_toc_html;
  try {
    await enqueueAndFlush(baseEvent({ grading, review_groups }), `목차 결과를 담았습니다${review_groups.length ? ` (복습 논점 ${review_groups.reduce((s, g) => s + g.items.length, 0)}개)` : ''}`);
    await idb.del('state', draftKey(c.file.id, 'toc')).catch(() => {});
    c.ed.clear();
    c.result = null;
    router.back();
  } catch (e) {
    shell.toast('보내지 못했습니다: ' + (e.message || e), 'error');
  }
}
