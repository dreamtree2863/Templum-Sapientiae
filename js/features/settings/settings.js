/* settings.js — 설정 · 동기화.
 *
 *  ‼ 이 화면이 왜 필요한가 — 실제로 겪은 일 때문이다.
 *    목록에 학습지가 안 뜨는데 "왜"를 볼 곳이 없었다(허브 타일이 빈 화면으로 갔다).
 *    원인은 옛 증분 커서였고, 그건 여기 "마지막 확인·목록 수" 한 줄이면 바로 보였다.
 *    그래서 이 화면의 목적은 꾸미기가 아니라 **조용한 실패를 드러내는 것**이다.
 */
import * as shell from '../shell.js';
import * as router from '../../core/router.js';
import { get } from '../../core/store.js';
import { auth, catalog, classify, log, outbox, uplink, search, refresh, storageInfo } from '../../data/index.js';
import { applyThemeAll, applyScaleAll } from '../viewer/viewer.js';
import { checkUpdate, runningVersion } from '../update.js';

const esc = shell.escapeHtml;
const SCALES = [0.9, 1, 1.15, 1.3];

/* ── 동기화 상태 ──────────────────────────────────────────────────── */
export async function renderSync() {
  const el = document.createElement('div');
  el.innerHTML = `<div class="rows" id="body">${rowsHtml(await syncFacts())}</div>
    <div id="queue">${queueHtml(await outbox.pending())}</div>
    <div class="set-actions">
      <button class="more-btn pressable" data-act="refresh">목록 새로고침</button>
      <button class="more-btn pressable" data-act="rescan">전체 다시 훑기</button>
      <button class="more-btn pressable" data-act="send">지금 PC 로 보내기</button>
      <button class="more-btn pressable" data-act="probe">폰 → PC 연결 시험</button>
      <button class="more-btn pressable" data-act="update">앱 갱신 확인</button>
    </div>
    <div id="probe"></div>
    <p class="set-note">“전체 다시 훑기”는 Drive 를 처음부터 다시 셉니다.
      목록이 오래돼 보이거나 새로 만든 자료가 안 보일 때 씁니다(9천여 개라 조금 걸립니다).</p>`;

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'send') { await onSend(el, b); return; }
    if (b.dataset.act === 'probe') { await onProbe(el, b); return; }
    if (b.dataset.act === 'update') {
      b.disabled = true; b.textContent = '확인 중…';
      try {
        const r = await checkUpdate();
        shell.toast(!r.ok ? (r.reason || '확인 실패')
          : r.found ? '새 버전이 있습니다 — 위 배너에서 적용하세요' : '이미 최신입니다', r.found ? 'ok' : '');
      } catch (err) { shell.toast('확인 실패', 'error'); }
      b.disabled = false; b.textContent = '앱 갱신 확인';
      return;
    }
    const force = b.dataset.act === 'rescan';
    b.disabled = true;
    b.textContent = force ? '훑는 중…' : '받는 중…';
    try {
      const r = await refresh({ force, onProgress: (n) => { b.textContent = `${n.toLocaleString()}개…`; } });
      shell.toast(r.mode === 'nochange' ? '변경 없음' : `${(r.total || 0).toLocaleString()}개`);
      el.querySelector('#body').innerHTML = rowsHtml(await syncFacts());
      el.querySelector('#queue').innerHTML = queueHtml(await outbox.pending());
    } catch (err) {
      shell.toast(err.message || '새로고침 실패', 'error');
    }
    b.disabled = false;
    b.textContent = force ? '전체 다시 훑기' : '목록 새로고침';
  });

  shell.render({ title: '동기화 상태', back: true, node: el });
}

/* 지금 보내기 — 권한이 없으면 동의 화면부터 띄운다(처음 한 번). */
async function onSend(el, b) {
  b.disabled = true; b.textContent = '보내는 중…';
  try {
    const r = await uplink.flush({ silent: false });
    if (r.skipped === 'no-write-scope') {
      shell.toast('먼저 쓰기 권한에 동의해 주세요');
      auth.ensureWriteScope();
    } else if (r.skipped) {
      shell.toast({ offline: '오프라인입니다', 'signed-out': '로그인이 필요합니다',
                    busy: '보내는 중입니다' }[r.skipped] || r.skipped);
    } else {
      shell.toast(r.sent ? `${r.sent}건 보냈습니다` : '보낼 것이 없습니다', 'ok');
    }
  } catch (e) {
    shell.toast(e.message || '보내지 못했습니다', 'error');
  }
  b.disabled = false; b.textContent = '지금 PC 로 보내기';
  el.querySelector('#body').innerHTML = rowsHtml(await syncFacts());
  el.querySelector('#queue').innerHTML = queueHtml(await outbox.pending());
}

/* 연결 시험 — 어디까지 되고 어디서 막히는지 단계별로 보여 준다.
   ‼ `drive.file` 권한으로 Templum 안에 `_inbox` 를 만들 수 있는지가 핵심이다. */
async function onProbe(el, b) {
  b.disabled = true; b.textContent = '시험 중…';
  let r;
  try { r = await uplink.probe(); }
  catch (e) { r = { ok: false, steps: [{ name: '시험', ok: false, detail: e.message }] }; }
  b.disabled = false; b.textContent = '폰 → PC 연결 시험';

  if (r.needScope) {
    el.querySelector('#probe').innerHTML =
      `<p class="set-note">PC 로 보내려면 Drive 쓰기 권한이 필요합니다.
        아래를 누르면 구글 동의 화면이 뜹니다(처음 한 번).</p>`;
    auth.ensureWriteScope();
    return;
  }
  el.querySelector('#probe').innerHTML = `
    <h3 class="set-sub">연결 시험 ${r.ok ? '— 통과' : '— 막힘'}</h3>
    <div class="rows">${r.steps.map(s2 => `<div class="set-row">
      <span class="k">${s2.ok ? '✓' : '✗'} ${esc(s2.name)}</span>
      <span class="v ${s2.ok ? 'good' : 'warn'}">${esc(s2.detail || (s2.ok ? '됨' : '안 됨'))}</span>
    </div>`).join('')}</div>
    ${r.scopeTooNarrow ? `<p class="set-note">‼ 좁은 권한(drive.file)으로는 Templum 안에
      폴더를 만들지 못합니다. 더 넓은 권한이 필요하다는 뜻이니 알려 주세요.</p>` : ''}`;
}

async function syncFacts() {
  const c = get('catalog');
  // ‼ "새 기능이 왜 안 보이지"를 없애는 한 줄 — 지금 도는 셸이 몇 판인지 보여 준다
  let ver = '';
  try { ver = await runningVersion(); } catch (e) { /* 무시 */ }
  const a = get('auth');
  const counts = {};
  for (const f of catalog.files()) {
    if (classify.isAudio(f.name) || classify.isSystemPath(f.path)) continue;
    const k = classify.classify(f).kind;
    counts[k] = (counts[k] || 0) + 1;
  }
  const audio = catalog.files().filter(f => classify.isAudio(f.name)).length;
  return [
    ['연결', navigator.onLine ? (a.signedIn ? '로그인됨' : '로그인 안 됨') : '오프라인',
      navigator.onLine && a.signedIn ? 'good' : navigator.onLine ? 'warn' : 'off'],
    ['마지막 확인', c.fetchedAt ? when(c.fetchedAt) : '아직 없음', c.fetchedAt ? '' : 'warn'],
    ['목록', (c.total || 0).toLocaleString() + '개', c.total ? '' : 'warn'],
    ['백지 인출', (counts.recall || 0) + '편', counts.recall ? '' : 'warn'],
    ['복기 퀴즈', (counts.quiz || 0) + '편', counts.quiz ? '' : 'warn'],
    ['낭독 음성', audio.toLocaleString() + '개', ''],
    ['보낼 기록', (get('outbox').pending || 0) + '건', ''],
    ['앱 버전', ver ? ver.replace('templum-shell-', '') : '확인 불가', ver ? '' : 'warn'],
  ];
}

/** 아직 PC 로 못 보낸 것들 — 무엇이 기다리는지 보이면 불안하지 않다.
 *  ‼ 아직 올리는 길(4단계 업로드)이 없다. 그래서 "기다리는 중"이라고 솔직히 적는다. */
function queueHtml(rows) {
  if (!rows.length) return '';
  return `<h3 class="set-sub">보낼 기록 ${rows.length}건</h3>
    <div class="rows">${rows.slice(0, 20).map(r => `<div class="set-row">
      <span class="k">${esc((r.name || '').replace(/\.html?$/i, ''))}</span>
      <span class="v">${r.kind === 'answers' ? r.count + '칸' : esc(r.kind)}
        <small>· ${when(r.ts)}</small></span>
    </div>`).join('')}</div>
    <p class="set-note">PC 로 보내는 길은 아직 열지 않았습니다(다음 단계).
      그때까지 이 기기에 안전하게 쌓아 둡니다 — 지워지지 않습니다.</p>`;
}

function rowsHtml(rows) {
  return rows.map(([k, v, tone]) => `<div class="set-row">
    <span class="k">${esc(k)}</span>
    <span class="v ${tone || ''}">${esc(v)}</span>
  </div>`).join('');
}

function when(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return m + '분 전';
  const h = Math.round(m / 60);
  if (h < 24) return h + '시간 전';
  return Math.round(h / 24) + '일 전';
}

/* ── 저장 공간 ────────────────────────────────────────────────────── */
export async function renderStorage() {
  const s = await storageInfo();
  const used = s.idb?.usage || 0, quota = s.idb?.quota || 0;
  const pct = quota ? Math.min(100, Math.round(100 * used / quota)) : 0;
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="gauge"><span style="width:${pct}%"></span></div>
    <div class="rows">
      ${rowsHtml([
        ['쓰는 중', mb(used) + (quota ? ` / ${mb(quota)} (${pct}%)` : ''), pct > 85 ? 'warn' : ''],
        // localStorage 에는 학습지 답안도 들어간다 — 5MB 한도가 여기서 보여야 한다
        ['답안 · 설정값', Math.round((s.local || 0) / 1024).toLocaleString() + 'KB / 5,120KB',
          (s.local || 0) > 4 * 1024 * 1024 ? 'warn' : ''],
      ])}
    </div>
    <div class="set-actions">
      <button class="more-btn pressable" data-act="docs">받아 둔 문서 비우기</button>
    </div>
    <p class="set-note">받아 둔 문서를 비워도 답안은 지워지지 않습니다.
      다시 열 때 Drive 에서 받아 옵니다.</p>`;

  el.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-act="docs"]')) return;
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('templum-docs')).map(n => caches.delete(n)));
    shell.toast('받아 둔 문서를 비웠습니다');
    router.go('#/settings/storage', { replace: true });
  });

  shell.render({ title: '저장 공간', back: true, node: el });
}

function mb(b) {
  if (!b) return '0MB';
  return b >= 1e9 ? (b / 1e9).toFixed(1) + 'GB' : Math.round(b / 1e6) + 'MB';
}

/* ── 테마 · 글자 크기 ─────────────────────────────────────────────── */
export function renderDisplay() {
  const ui = get('ui');
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="set-group"><h3>밝기</h3><div class="seg">
      ${['system', 'light', 'dark'].map(t => `<button class="seg-b${ui.theme === t ? ' on' : ''}" data-theme="${t}">
        ${{ system: '시스템', light: '밝게', dark: '어둡게' }[t]}</button>`).join('')}
    </div></div>
    <div class="set-group"><h3>글자 크기</h3><div class="seg">
      ${SCALES.map(s => `<button class="seg-b${ui.textScale === s ? ' on' : ''}" data-scale="${s}">
        ${Math.round(s * 100)}%</button>`).join('')}
    </div></div>
    <p class="set-note">문서 안에서도 하단 툴바로 바꿀 수 있습니다. 여기서 정한 값이 기본입니다.</p>`;

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-theme]');
    if (t) { applyThemeAll(t.dataset.theme); mark(el, '[data-theme]', t); return; }
    const s = e.target.closest('[data-scale]');
    if (s) { applyScaleAll(Number(s.dataset.scale)); mark(el, '[data-scale]', s); }
  });

  shell.render({ title: '테마 · 글자 크기', back: true, node: el });
}

function mark(el, sel, on) {
  el.querySelectorAll(sel).forEach(b => b.classList.toggle('on', b === on));
}

/* ── AI 키 ────────────────────────────────────────────────────────
 *  ‼ 키는 이 기기에만 둔다. 어디로도 보내지 않고, Google 에 직접 물을 때만 쓴다.
 *    키가 없어도 '문서 AI' 의 찾기는 그대로 된다 — 막지 않는다.
 */
export function renderAi() {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="set-group"><h3>Gemini 키</h3>
      <input type="password" id="key" class="set-input" placeholder="AI…"
             autocomplete="off" value="${search.hasKey() ? '••••••••••••' : ''}">
    </div>
    <div class="set-group"><h3>모델</h3>
      <input type="text" id="model" class="set-input" placeholder="gemini-2.5-flash"
             autocomplete="off" value="${esc(search.getModel())}">
    </div>
    <div class="set-actions">
      <button class="more-btn pressable" data-act="save">저장</button>
      <button class="more-btn pressable" data-act="clear">키 지우기</button>
    </div>
    <p class="set-note">키는 이 기기에만 저장되며 다른 곳으로 보내지 않습니다.
      키가 없어도 문서 AI 의 <b>찾기</b>는 그대로 됩니다 — 관련 문서를 골라 주고
      근거 단락까지 추려 줍니다. AI 답변만 키가 필요합니다.</p>`;

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'clear') {
      search.setKey('');
      shell.toast('키를 지웠습니다');
      router.go('#/settings/ai', { replace: true });
      return;
    }
    const k = el.querySelector('#key').value.trim();
    if (k && !/^[•]+$/.test(k)) search.setKey(k);
    const m = el.querySelector('#model').value.trim();
    search.setModel(m);
    shell.toast('저장했습니다', 'ok');
  });

  shell.render({ title: 'AI 키', back: true, node: el });
}

/* ── 기록 ─────────────────────────────────────────────────────────── */
export function renderLog() {
  const rows = log.recent(120);
  const el = document.createElement('div');
  el.innerHTML = rows.length
    ? `<div class="logs">${rows.map(r => `<div class="log-row l-${esc(r.level)}">
        <span class="t">${new Date(r.at).toLocaleTimeString('ko-KR', { hour12: false })}</span>
        <span class="g">${esc(r.tag)}</span>
        <span class="m">${esc(r.msg)}</span>
      </div>`).join('')}</div>`
    : `<div class="empty">기록이 없습니다.</div>`;
  const act = document.createElement('div');
  act.className = 'set-actions';
  act.innerHTML = `<button class="more-btn pressable" data-act="copy">기록 복사</button>`;
  act.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(log.dump()); shell.toast('복사했습니다'); }
    catch (e) { shell.toast('복사하지 못했습니다', 'error'); }
  });
  el.appendChild(act);
  shell.render({ title: '기록', back: true, node: el });
}
