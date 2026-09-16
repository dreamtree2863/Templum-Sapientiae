/* mcq.js — 객관식 시험. 탭만으로 끝난다.
 *
 *  ‼ 이동 중 학습에 가장 맞는 형태다 — 타이핑이 0 이고, 한 손으로 된다.
 *    그래서 화면도 그렇게 짠다: 문항 하나 + 선택지 + [다음]. 스크롤은 본문만.
 *
 *  ‼ 문제 본문(stem)은 PC 가 만든 HTML 그대로다(표·그림이 들어 있다).
 *    우리가 다시 쓰지 않고 그대로 넣되, 넘치지 않게 가둔다.
 */
import * as shell from '../shell.js';
import * as router from '../../core/router.js';
import { mcq } from '../../data/index.js';

const esc = shell.escapeHtml;

let exam = null;   // {subject,set,file,items,at,answers,started}

/* ── 세트 고르기 ──────────────────────────────────────────────────── */

export async function renderSets() {
  let list = await mcq.sets();
  const el = document.createElement('div');

  if (!list.length) {
    el.innerHTML = `<div class="empty">아직 문제은행을 받지 못했습니다.<br>
      PC 를 한 번 켜 두면 폰으로 넘어옵니다.</div>`;
  } else {
    const bySubject = {};
    for (const s of list) (bySubject[s.subject] || (bySubject[s.subject] = [])).push(s);
    el.innerHTML = Object.entries(bySubject).map(([sub, rows]) => `
      <h3 class="set-sub">${esc(sub)}</h3>
      <div class="doc-list">${rows.map(r => `
        <button class="doc-row pressable" data-set="${esc(r.file)}">
          <span class="doc-name">${esc(r.set)}</span>
          <span class="doc-meta">
            <span class="kind">${r.count}문항</span>
            ${r.explained ? `<span class="kind k-recall">해설 ${r.explained}</span>` : ''}
            <span class="where">${Math.round(r.bytes / 1024)}KB</span>
          </span>
        </button>`).join('')}</div>`).join('');
  }

  const b = document.createElement('button');
  b.className = 'more-btn pressable';
  b.textContent = '세트 목록 새로 받기';
  b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '받는 중…';
    try {
      const r = await mcq.pullIndex();
      shell.toast(r == null ? 'PC 가 아직 안 내보냈습니다' : `${r.length}세트`, 'ok');
      renderSets();
    } catch (e) { shell.toast(e.message, 'error'); b.disabled = false; b.textContent = '세트 목록 새로 받기'; }
  });
  el.appendChild(b);

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-set]');
    if (!t) return;
    shell.toast('문제를 받는 중…');
    try {
      const d = await mcq.loadSet(t.dataset.set);
      start(d, t.dataset.set);
    } catch (err) { shell.toast(err.message, 'error'); }
  });

  shell.render({ title: '객관식 시험', back: true, node: el });
}

/* ── 시험 ─────────────────────────────────────────────────────────── */

function start(d, file, items) {
  exam = {
    subject: d.subject, set: d.set, file,
    items: mcq.shuffle(items || d.questions),
    at: 0, answers: [], started: Date.now(),
  };
  paint();
}

function paint() {
  const q = exam.items[exam.at];
  if (!q) { renderResult(); return; }
  const picked = exam.answers[exam.at];

  const el = document.createElement('div');
  el.className = 'mcq';
  el.innerHTML = `
    <div class="mcq-top">
      <span class="rv-count">${exam.at + 1} / ${exam.items.length}</span>
      <span class="rv-sub">${esc(exam.set)}</span>
      <span class="mcq-clock" id="clock">0:00</span>
    </div>
    <div class="mcq-stem">${q.stem || ''}</div>
    <div class="mcq-choices">
      ${(q.choices || []).map((c, i) => `
        <button class="mcq-c pressable${picked && picked.chosen === c.label ? ' on' : ''}"
                data-pick="${esc(c.label || String(i + 1))}">
          <span class="lab">${esc(c.label || (i + 1))}</span>
          <span class="txt">${esc(c.text || '')}</span>
        </button>`).join('')}
    </div>
    <div class="mcq-nav">
      <button class="mcq-nb pressable" data-go="-1"${exam.at ? '' : ' disabled'}>이전</button>
      <button class="mcq-nb pressable" data-go="1">${exam.at + 1 === exam.items.length ? '채점' : '다음'}</button>
    </div>`;

  el.addEventListener('click', onClick);
  shell.render({ title: '객관식 시험', back: true, node: el });
  tick();
}

let clockTimer = null;
function tick() {
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    const el = document.getElementById('clock');
    if (!el || !exam) { clearInterval(clockTimer); return; }
    const s = Math.floor((Date.now() - exam.started) / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

function onClick(e) {
  const p = e.target.closest('[data-pick]');
  if (p) {
    const q = exam.items[exam.at];
    exam.answers[exam.at] = {
      num: q.num, chosen: p.dataset.pick,
      correct: mcq.isCorrect(q, p.dataset.pick), q,
    };
    // 고르면 바로 다음으로 — 한 손 조작에서 탭 한 번이 아깝다
    setTimeout(() => { exam.at += 1; paint(); }, 160);
    paint();
    return;
  }
  const g = e.target.closest('[data-go]');
  if (!g || g.disabled) return;
  exam.at = Math.max(0, exam.at + Number(g.dataset.go));
  paint();
}

/* ── 결과 ─────────────────────────────────────────────────────────── */

async function renderResult() {
  clearInterval(clockTimer);
  const answered = exam.items.map((q, i) => exam.answers[i]
    || { num: q.num, chosen: '', correct: false, q });
  const right = answered.filter(a => a.correct).length;
  const elapsed = Math.floor((Date.now() - exam.started) / 1000);

  await mcq.submit({
    subject: exam.subject, set: exam.set, file: exam.file,
    answers: answered.map(({ num, chosen, correct }) => ({ num, chosen, correct })),
    elapsed,
  });
  await mcq.rememberWrong(exam.subject, exam.set, exam.file,
    answered.filter(a => !a.correct).map(a => ({ num: a.num, q: a.q })));
  await mcq.clearWrong(exam.subject, exam.set,
    answered.filter(a => a.correct).map(a => a.num));

  const pct = Math.round(100 * right / answered.length);
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="rv-done">
      <div class="rv-done-n">${right} / ${answered.length}</div>
      <p>${pct}점 · ${Math.floor(elapsed / 60)}분 ${elapsed % 60}초</p>
      <p class="set-note">틀린 문항은 오답 재시험에 쌓입니다. 결과는 PC 로 넘어갑니다.</p>
    </div>
    <h3 class="set-sub">문항별</h3>
    <div class="mcq-grid">
      ${answered.map((a, i) => `<button class="mcq-gcell ${a.correct ? 'ok' : 'bad'}"
         data-review="${i}">${i + 1}</button>`).join('')}
    </div>
    <div id="detail"></div>`;

  el.addEventListener('click', (e) => {
    const r = e.target.closest('[data-review]');
    if (!r) return;
    const a = answered[Number(r.dataset.review)];
    el.querySelector('#detail').innerHTML = `
      <div class="mcq-detail">
        <div class="mcq-stem">${a.q.stem || ''}</div>
        <div class="rows">
          <div class="set-row"><span class="k">내 답</span>
            <span class="v ${a.correct ? 'good' : 'warn'}">${esc(a.chosen || '안 고름')}</span></div>
          <div class="set-row"><span class="k">정답</span>
            <span class="v good">${esc(a.q.answer || '')}</span></div>
        </div>
        ${a.q.explanation ? `<div class="mcq-exp">${a.q.explanation}</div>` : ''}
      </div>`;
    el.querySelector('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const b = document.createElement('button');
  b.className = 'more-btn pressable';
  b.textContent = '다른 세트 고르기';
  b.addEventListener('click', () => router.go('#/review/mcq'));
  el.appendChild(b);
  exam = null;
  shell.render({ title: '채점 결과', back: true, node: el });
}

/* ── 오답 재시험 ──────────────────────────────────────────────────── */

export async function renderWrong() {
  const { pc, local } = await mcq.wrongPool();
  const el = document.createElement('div');

  if (!local.length && !pc.length) {
    el.innerHTML = `<div class="empty">틀린 문항이 없습니다.<br>
      객관식 시험을 보면 틀린 것만 여기 모입니다.</div>`;
    shell.render({ title: '오답 재시험', back: true, node: el });
    return;
  }

  // 이 기기에서 틀린 것은 문항을 통째로 들고 있어 바로 다시 풀 수 있다
  const ready = local.filter(x => x.q && (x.q.choices || []).length);
  el.innerHTML = `
    <div class="rows">
      <div class="set-row"><span class="k">이 기기에서 틀린 것</span>
        <span class="v">${local.length}문항</span></div>
      <div class="set-row"><span class="k">PC 오답노트</span>
        <span class="v">${pc.length}문항</span></div>
    </div>
    ${ready.length ? '' : `<p class="set-note">다시 풀 수 있는 문항이 아직 없습니다.
      (PC 오답노트는 PC 에서 풀도록 되어 있습니다.)</p>`}`;

  if (ready.length) {
    const b = document.createElement('button');
    b.className = 'more-btn pressable';
    b.textContent = `틀린 ${ready.length}문항 다시 풀기`;
    b.addEventListener('click', () => {
      start({ subject: ready[0].subject, set: '오답 재시험', questions: [] },
        ready[0].file, ready.map(x => x.q));
    });
    el.appendChild(b);
  }
  shell.render({ title: '오답 재시험', back: true, node: el });
}
