/* scan.js — 종이 문서·손글씨 답안 스캔 → PDF 로 묶어 Drive 로.
 *
 *  #/scan                    일반 문서 — Drive Templum/스캔/ 에 사진+PDF
 *  #/scan?problem=<문제 id>   손글씨 답안 — 같은 곳에 올리고 PC 로 알린다(PC 채점 화면 › 📱 폰 답안 에 📷 로 뜸)
 *
 *  ‼ 화질: 카메라 미리보기 영상이 아니라 폰 카메라 앱의 원본 사진을 받는다(<input capture>).
 *    처리는 imaging.js — 원본 화소에서 한 번 펴고, 조명만 고르고, JPEG 은 마지막에 한 번.
 *  ‼ 찍은 원본·모서리는 바뀔 때마다 IndexedDB 에 적는다 — 앱이 죽어도 이어서 보낸다.
 *  ‼ 원본은 보내기 직전에만 하나씩 디코드한다(12MP 한 장 ≈ 48MB — 여러 장을 들고 있으면 폰이 죽는다).
 */
import * as shell from '../shell.js';
import * as router from '../../core/router.js';
import * as log from '../../core/log.js';
import { catalog, classify, scans } from '../../data/index.js';
import * as im from './imaging.js';
import { buildPdf } from './pdf.js';

const esc = shell.escapeHtml;
const THUMB = 520;
let S = null;
const tick = () => new Promise(r => setTimeout(r, 30));     // 진행 글자가 그려질 틈
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ── 열기 ─────────────────────────────────────────────────────────── */
export async function open(params = {}) {
  leave();
  let problem = params.problem ? catalog.byId(params.problem) : null;
  // 앱을 이 화면에서 다시 열면(찍다 만 스캔 잇기) 라우터가 목록 캐시보다 먼저 돈다 — 잠깐 기다린다
  for (let i = 0; params.problem && !problem && i < 30; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (!location.hash.startsWith('#/scan')) return;
    problem = catalog.byId(params.problem);
  }
  if (params.problem && !problem) {
    shell.render({ title: '스캔', back: true, html: '<div class="empty">문제를 찾지 못했습니다.<br>목록을 새로고침해 보세요.</div>' });
    return;
  }
  const draft = await scans.loadDraft();
  const target = problem?.id || '';
  if (draft?.pages?.length && (draft.problemId || '') !== target) {
    const what = draft.problemId ? '다른 문제의 답안 스캔' : '보내지 않은 문서 스캔';
    if (!confirm(`${what} ${draft.pages.length}쪽이 남아 있습니다.\n[확인] 그것을 버리고 새로 시작 · [취소] 그 스캔으로 가기`)) {
      router.go('#/scan' + (draft.problemId ? '?problem=' + encodeURIComponent(draft.problemId) : ''), { replace: true });
      return;
    }
    await scans.clearDraft();
  }
  const same = draft?.pages?.length && (draft.problemId || '') === target;
  const info = problem ? classify.classify(problem) : null;
  const defTitle = problem ? (info?.baseTitle || problem.name.replace(/\.html?$/i, '')) : '';

  const el = document.createElement('div');
  el.className = 'scan-wrap';
  el.innerHTML = `
    <div class="scan-head">
      ${problem
        ? `<div class="scan-prob">📝 <b>${esc(defTitle)}</b><span>손글씨 답안 → Drive · PC 채점</span></div>`
        : `<input id="sc-title" class="scan-title" placeholder="문서 이름 (예: 행정법 판례 메모)" value="${esc(same ? draft.title || '' : '')}">`}
      <div class="scan-tip">폰 카메라 앱의 <b>원본 화질</b>로 찍습니다. 밝은 곳에서 종이 네 귀가 다 보이게 —
        어두운 바닥에 놓으면 자동 자르기가 잘 됩니다. 쪽을 누르면 모서리를 직접 맞춥니다.</div>
    </div>
    <div id="sc-pages" class="scan-pages"></div>
    <div class="scan-actions">
      <label class="scan-btn pressable" title="카메라로 한 쪽 찍기">📷 찍기<input id="sc-cam" type="file" accept="image/*" capture="environment" hidden></label>
      <label class="scan-btn pressable" title="앨범에서 여러 장">🖼 앨범<input id="sc-gal" type="file" accept="image/*" multiple hidden></label>
      <select id="sc-mode" title="문서 보정 = 그림자·조명색을 지워 종이를 하얗게(획은 그대로) · 원본 색 = 보정 없음">
        <option value="doc">보정</option>
        <option value="color">원본</option>
      </select>
      <button class="btn-primary pressable" id="sc-send" disabled>📤 보내기</button>
    </div>`;
  shell.render({ title: problem ? '답안 스캔' : '문서 스캔', back: true, node: el });
  document.body.classList.add('scanning');

  S = { problem, defTitle, el, mode: same ? (draft.mode || 'doc') : 'doc', busy: false, editor: null,
        pages: same ? draft.pages.map(p => ({ ...p, thumb: '' })) : [] };
  el.querySelector('#sc-mode').value = S.mode;
  el.querySelector('#sc-mode').addEventListener('change', async (e) => {
    S.mode = e.target.value;
    save();
    for (const p of S.pages) { await refreshThumb(p); }
  });
  el.querySelector('#sc-title')?.addEventListener('input', save);
  for (const id of ['#sc-cam', '#sc-gal']) {
    el.querySelector(id).addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';                    // 같은 사진을 다시 골라도 change 가 오게
      if (files.length) addFiles(files);
    });
  }
  el.querySelector('#sc-send').addEventListener('click', send);
  paint();
  if (same) {
    shell.toast(`찍어 둔 ${S.pages.length}쪽을 이어서 합니다`, 'info');
    for (const p of S.pages) { if (S?.el !== el) return; await refreshThumb(p); }
  }
}

export function leave() {
  document.body.classList.remove('scanning');
  if (!S) return;
  closeEditor();
  for (const p of S.pages) if (p.thumb) URL.revokeObjectURL(p.thumb);
  S = null;
}

function title() {
  if (S.problem) return S.defTitle;
  const v = S.el.querySelector('#sc-title')?.value.trim();
  if (v) return v;
  const d = new Date();
  return `스캔 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function save() {
  if (!S) return;
  if (!S.pages.length) { scans.clearDraft(); return; }
  scans.saveDraft({
    problemId: S.problem?.id || '', title: S.el.querySelector('#sc-title')?.value || '',
    mode: S.mode, savedAt: Date.now(),
    pages: S.pages.map(({ id, blob, corners, rot, auto }) => ({ id, blob, corners, rot, auto })),
  });
}

/* ── 쪽 추가 ─────────────────────────────────────────────────────────── */
async function addFiles(files) {
  const s = S;
  for (let i = 0; i < files.length; i++) {
    if (S !== s) return;
    shell.progress(`사진 읽는 중 ${i + 1}/${files.length}…`);
    await tick();
    const p = { id: newId(), blob: files[i], corners: null, rot: 0, auto: false, thumb: '' };
    try {
      const src = await im.decode(p.blob);
      const q = im.detectCorners(src);
      p.corners = q || im.FULL; p.auto = !!q;
      await refreshThumb(p, src);
      im.release(src);
    } catch (e) {
      log.warn('scan', '사진 처리 실패', e);
      shell.toast('이 사진을 읽지 못했습니다: ' + (e.message || e), 'error');
      continue;
    }
    S.pages.push(p);
    paint();
    save();
  }
  shell.progressDone('');
  const last = S?.pages[S.pages.length - 1];
  if (last && !last.auto) shell.toast('종이 가장자리를 못 찾아 전체를 씁니다 — 쪽을 눌러 모서리를 맞추세요', 'info', 4500);
}

async function refreshThumb(p, src) {
  let own = false;
  try {
    if (!src) { src = await im.decode(p.blob); own = true; }
    const cv = im.render(src, p.corners, { rot: p.rot, mode: S?.mode || 'doc', maxOut: THUMB });
    const b = await im.toJpeg(cv, 0.8);
    im.release(cv);
    if (p.thumb) URL.revokeObjectURL(p.thumb);
    p.thumb = URL.createObjectURL(b);
    const img = S?.el.querySelector(`[data-id="${p.id}"] img`);
    if (img) img.src = p.thumb;
  } catch (e) { log.warn('scan', '미리보기 실패', e); }
  finally { if (own) im.release(src); }
}

/* ── 목록 ─────────────────────────────────────────────────────────── */
function paint() {
  if (!S) return;
  const box = S.el.querySelector('#sc-pages');
  if (!S.pages.length) {
    box.innerHTML = `<div class="scan-empty">📷 찍기로 첫 쪽을 찍으세요.<br><small>여러 쪽이면 한 쪽씩 차례로 — 순서는 나중에 바꿀 수 있습니다.</small></div>`;
  } else {
    box.innerHTML = S.pages.map((p, i) => `
      <div class="scan-page" data-id="${p.id}">
        <button class="scan-thumb" data-act="edit" data-i="${i}" aria-label="${i + 1}쪽 자르기">
          ${p.thumb ? `<img src="${p.thumb}" alt="">` : '<img alt="">'}
          <span class="scan-no">${i + 1}</span>
        </button>
        <div class="scan-page-bar">
          <button data-act="edit" data-i="${i}">✂ 자르기</button>
          <button data-act="up" data-i="${i}" ${i ? '' : 'disabled'} aria-label="앞으로">↑</button>
          <button data-act="down" data-i="${i}" ${i < S.pages.length - 1 ? '' : 'disabled'} aria-label="뒤로">↓</button>
          <button data-act="del" data-i="${i}" aria-label="지우기">🗑</button>
        </div>
      </div>`).join('');
    box.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act, +b.dataset.i)));
  }
  const send = S.el.querySelector('#sc-send');
  send.disabled = !S.pages.length || S.busy;
  send.textContent = S.pages.length ? `📤 ${S.pages.length}쪽 보내기` : '📤 보내기';
}

function act(a, i) {
  if (!S || S.busy) return;
  const P = S.pages;
  if (a === 'edit') { openEditor(i); return; }
  if (a === 'up' && i > 0) [P[i - 1], P[i]] = [P[i], P[i - 1]];
  if (a === 'down' && i < P.length - 1) [P[i + 1], P[i]] = [P[i], P[i + 1]];
  if (a === 'del') {
    if (!confirm(`${i + 1}쪽을 지울까요?`)) return;
    const [gone] = P.splice(i, 1);
    if (gone?.thumb) URL.revokeObjectURL(gone.thumb);
  }
  paint();
  save();
}

/* ── 자르기(모서리 맞추기) ─────────────────────────────────────────────── */
async function openEditor(i) {
  const p = S.pages[i];
  if (!p) return;
  closeEditor();
  const ov = document.createElement('div');
  ov.className = 'scan-edit';
  ov.innerHTML = `
    <div class="scan-edit-stage"><canvas id="se-cv"></canvas><canvas id="se-loupe" class="scan-loupe" width="240" height="240" hidden></canvas></div>
    <div class="scan-edit-info" id="se-info">${i + 1}쪽 — 동그라미 네 개를 종이 귀퉁이로 끌어 맞추세요</div>
    <div class="scan-edit-bar">
      <button data-e="auto">자동</button>
      <button data-e="full">전체</button>
      <button data-e="rot">⟳ 회전</button>
      <span style="flex:1"></span>
      <button data-e="cancel">취소</button>
      <button class="btn-primary" data-e="ok">완료</button>
    </div>`;
  document.body.appendChild(ov);
  shell.progress('사진 여는 중…');
  await tick();
  let src;
  try { src = await im.decode(p.blob); } catch (e) { shell.progressDone(''); ov.remove(); shell.toast('사진을 열지 못했습니다', 'error'); return; }
  const disp = im.scaled(src, 1600);       // 화면용 — 원본은 보내기 때만
  shell.progressDone('');
  const E = { ov, p, src, disp, q: (p.corners || im.FULL).map(c => c.slice()), rot: p.rot || 0, drag: -1, box: null };
  S.editor = E;

  const cv = ov.querySelector('#se-cv'), loupe = ov.querySelector('#se-loupe');
  const stage = ov.querySelector('.scan-edit-stage');
  const layout = () => {
    const dpr = window.devicePixelRatio || 1;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    cv.width = Math.round(sw * dpr); cv.height = Math.round(sh * dpr);
    cv.style.width = sw + 'px'; cv.style.height = sh + 'px';
    const pad = 22;
    const s = Math.min((sw - 2 * pad) / disp.width, (sh - 2 * pad) / disp.height);
    E.box = { x: (sw - disp.width * s) / 2, y: (sh - disp.height * s) / 2, w: disp.width * s, h: disp.height * s, dpr };
    draw();
  };
  const toScreen = ([x, y]) => [E.box.x + x * E.box.w, E.box.y + y * E.box.h];
  const draw = () => {
    const x = cv.getContext('2d'), { dpr } = E.box;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, cv.width, cv.height);
    x.drawImage(disp, E.box.x, E.box.y, E.box.w, E.box.h);
    const pts = E.q.map(toScreen);
    x.fillStyle = 'rgba(0,0,0,.45)';                 // 바깥을 어둡게
    x.beginPath(); x.rect(0, 0, cv.width / dpr, cv.height / dpr);
    x.moveTo(...pts[0]); pts.slice(1).forEach(p => x.lineTo(...p)); x.closePath();
    x.fill('evenodd');
    x.strokeStyle = '#4fc3f7'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(...pts[0]); pts.slice(1).forEach(p => x.lineTo(...p)); x.closePath(); x.stroke();
    pts.forEach(([px, py], k) => {
      x.beginPath(); x.arc(px, py, k === E.drag ? 16 : 13, 0, Math.PI * 2);
      x.fillStyle = 'rgba(79,195,247,.35)'; x.fill();
      x.lineWidth = 3; x.strokeStyle = '#fff'; x.stroke();
    });
    ov.querySelector('#se-info').textContent =
      `${S.pages.indexOf(p) + 1}쪽 — 귀퉁이를 끌어 맞추세요${E.rot ? ` · 회전 ${E.rot}°` : ''}`;
  };
  const drawLoupe = (k) => {
    const [px, py] = toScreen(E.q[k]);
    const Z = 3, R = 120;
    const lx = loupe.getContext('2d');
    // 손가락과 반대쪽 위 구석에 띄운다
    loupe.style.left = (px < stage.clientWidth / 2 ? stage.clientWidth - 132 : 12) + 'px';
    loupe.hidden = false;
    const sx = E.q[k][0] * disp.width, sy = E.q[k][1] * disp.height;
    const span = (R * 2) / Z * (disp.width / E.box.w);
    lx.clearRect(0, 0, 240, 240);
    lx.save(); lx.beginPath(); lx.arc(R, R, R, 0, Math.PI * 2); lx.clip();
    lx.fillStyle = '#000'; lx.fillRect(0, 0, 240, 240);
    lx.drawImage(disp, sx - span / 2, sy - span / 2, span, span, 0, 0, 240, 240);
    lx.restore();
    lx.strokeStyle = '#4fc3f7'; lx.lineWidth = 2;
    lx.beginPath(); lx.moveTo(R - 14, R); lx.lineTo(R + 14, R); lx.moveTo(R, R - 14); lx.lineTo(R, R + 14); lx.stroke();
  };
  const pos = (ev) => { const r = cv.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  cv.addEventListener('pointerdown', (ev) => {
    const [mx, my] = pos(ev);
    let best = -1, bd = 44;
    E.q.forEach((c, k) => { const [px, py] = toScreen(c); const d = Math.hypot(px - mx, py - my); if (d < bd) { bd = d; best = k; } });
    if (best < 0) return;
    E.drag = best; cv.setPointerCapture(ev.pointerId);
    draw(); drawLoupe(best);
  });
  cv.addEventListener('pointermove', (ev) => {
    if (E.drag < 0) return;
    const [mx, my] = pos(ev);
    E.q[E.drag] = [Math.min(1, Math.max(0, (mx - E.box.x) / E.box.w)), Math.min(1, Math.max(0, (my - E.box.y) / E.box.h))];
    draw(); drawLoupe(E.drag);
  });
  const end = () => { E.drag = -1; loupe.hidden = true; draw(); };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  E.onResize = layout;
  window.addEventListener('resize', layout);

  ov.querySelectorAll('[data-e]').forEach(b => b.addEventListener('click', async () => {
    const e = b.dataset.e;
    if (e === 'auto') {
      const q = im.detectCorners(src);
      if (q) { E.q = q; draw(); } else shell.toast('종이 가장자리를 찾지 못했습니다 — 직접 맞춰 주세요', 'info');
    } else if (e === 'full') { E.q = im.FULL.map(c => c.slice()); draw(); }
    else if (e === 'rot') { E.rot = (E.rot + 90) % 360; draw(); }
    else if (e === 'cancel') closeEditor();
    else if (e === 'ok') {
      if (!im.convex(E.q) || im.quadArea(E.q) < 0.02) { shell.toast('네 귀퉁이가 꼬였습니다 — 순서대로(왼위·오위·오아래·왼아래) 맞춰 주세요', 'error', 4000); return; }
      p.corners = E.q; p.rot = E.rot; p.auto = false;
      save();
      await refreshThumb(p, src);
      closeEditor();
    }
  }));
  requestAnimationFrame(layout);
}

function closeEditor() {
  const E = S?.editor;
  if (!E) return;
  window.removeEventListener('resize', E.onResize);
  im.release(E.disp);
  im.release(E.src);
  E.ov.remove();
  S.editor = null;
}

/* ── 보내기 ─────────────────────────────────────────────────────────── */
async function send() {
  if (!S || S.busy || !S.pages.length) return;
  const s = S;
  // ‼ 맨 앞 — 로그인 갱신 팝업은 터치 안에서만 열린다(처리에 몇 초 걸린 뒤엔 막힌다)
  try { await scans.ensureWrite(); } catch (e) { shell.toast(e.message || 'Drive 연결이 필요합니다', 'error', 5000); return; }
  s.busy = true; paint();
  const n = s.pages.length;
  try {
    const blobs = [], meta = [];
    for (let i = 0; i < n; i++) {
      shell.progress(`원본 화질로 ${i + 1}/${n}쪽 펴는 중…`);
      await tick();
      const p = s.pages[i];
      const src = await im.decode(p.blob);
      const cv = im.render(src, p.corners, { rot: p.rot, mode: s.mode });
      im.release(src);
      const b = await im.toJpeg(cv);
      meta.push({ blob: b, w: cv.width, h: cv.height });
      blobs.push(b);
      im.release(cv);
    }
    shell.progress('PDF 묶는 중…');
    await tick();
    const pdf = await buildPdf(meta);
    const t = title();
    const r = await scans.send({ title: t, problem: s.problem, pages: blobs, pdf, onProgress: (m) => shell.progress(m) });
    await scans.clearDraft();
    shell.progressDone(`Drive ${r.folder} 에 올렸습니다`);
    log.info('scan', `${n}쪽 · ${meta.map(m => `${m.w}×${m.h}`).join(', ')} · PDF ${(pdf.size / 1048576).toFixed(1)}MB`);
    shell.toast(s.problem
      ? `${n}쪽을 올렸습니다 — PC 채점 화면 › 📱 폰 답안 에 📷 로 뜹니다(PC 동기화 뒤)`
      : `${n}쪽을 Drive '${r.folder}' 에 PDF 로 올렸습니다`, 'ok', 6000);
    if (S === s) {
      for (const p of s.pages) if (p.thumb) URL.revokeObjectURL(p.thumb);
      s.pages = [];
      if (s.problem) { router.back(); return; }
      paint();
    }
  } catch (e) {
    log.warn('scan', '보내기 실패', e);
    shell.progressDone('');
    shell.toast('보내지 못했습니다(찍은 것은 남아 있습니다): ' + (e.message || e), 'error', 6000);
  } finally {
    s.busy = false;
    if (S === s) paint();
  }
}
