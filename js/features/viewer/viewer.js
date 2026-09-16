/* viewer.js — 문서 뷰어. 이번 개편의 핵심.
 *
 *  ‼ 옛 구조는 `$('doc-content').innerHTML = inner` 한 줄이었다(app.js:979).
 *    그래서 문서의 <script> 가 실행되지 않고 <head><style> 이 버려졌다 —
 *    학습지의 저장·채점·정답지 토글이 전부 죽고, `.fb{position:absolute}` 가
 *    없어 그림 위 좌표 빈칸이 그림 아래로 쏟아졌다.
 *
 *  이제 blob: iframe 으로 띄운다. 문서는 제 스타일과 제 스크립트로 살아나고,
 *  우리는 없는 것만(viewport·MathJax·테마) 얹는다.
 */
import * as shell from '../shell.js';
import * as router from '../../core/router.js';
import * as idb from '../../core/idb.js';
import { get, patch } from '../../core/store.js';
import * as log from '../../core/log.js';
import { catalog, docContent, docRules, markOpened } from '../../data/index.js';
import { inject, injectMathLive, applyTheme, applyScale } from './inject.js';
import * as bridge from './frame-bridge.js';
import { mountToolbar } from './toolbar.js';

let cur = null;          // {file, frame, blobUrl, unlisten, plan, prefix, scrollY}

export async function open(fileId) {
  await close();                                   // 앞 문서를 확실히 치운다

  const file = catalog.byId(fileId);
  if (!file) {
    shell.render({ title: '문서', back: true, html: `<div class="empty">문서를 찾지 못했습니다.<br>목록을 새로고침해 보세요.</div>` });
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'doc-wrap';
  wrap.innerHTML = `
    <div class="doc-veil" id="doc-veil"><span class="spinner"></span> 문서를 여는 중…</div>
    <iframe id="doc-frame" title="${shell.escapeHtml(file.name)}"></iframe>`;
  shell.render({ title: file.name.replace(/\.html?$/i, ''), back: true, node: wrap, chrome: true });
  document.body.classList.add('reading');

  const frame = wrap.querySelector('#doc-frame');
  const veil = wrap.querySelector('#doc-veil');

  let doc;
  try {
    doc = await docContent.fetchDoc(file);
  } catch (e) {
    veil.innerHTML = shell.escapeHtml(e.message || '문서를 받지 못했습니다.');
    log.error('viewer', '문서 받기 실패', e);
    return;
  }

  const plan = docRules.planFor(file.path + '/' + file.name, doc.head);
  const ui = get('ui');
  const blobUrl = URL.createObjectURL(doc.blob);

  cur = { file, frame, blobUrl, plan, prefix: doc.prefix, unlisten: null, scrollY: 0 };
  markOpened(file);

  // 문서가 말을 걸어 오는 통로
  cur.unlisten = bridge.listen(frame, {
    'typeset-done': () => hideVeil(veil),
    'agent-ready': async () => {
      const saved = await idb.get('docPos', file.id).catch(() => null);
      if (saved?.y) bridge.scrollTo(frame, saved.y);
    },
    scroll: (m) => {
      cur.scrollY = m.y;
      idb.put('docPos', file.id, {
        y: m.y, at: Date.now(), id: file.id, name: file.name, path: file.path,
      }).catch(() => {});
    },
    link: (m) => onLink(m, file),
    'answers-changed': () => { cur.dirty = true; },     // 4단계에서 여기서 모은다
  });

  frame.addEventListener('load', () => {
    const d = frame.contentDocument;
    if (!d) { hideVeil(veil); return; }
    try {
      inject(d, plan, { theme: ui.theme, textScale: ui.textScale });
      bridge.installAgent(d);
      if (plan.mathlive) injectMathLive(d);
    } catch (e) {
      log.warn('viewer', '자산 주입 실패', e);
    }
    // MathJax 가 조판을 끝냈다고 알려 주기 전에도 오래 가리지 않는다
    setTimeout(() => hideVeil(veil), plan.mathjax ? 6000 : 400);
  }, { once: true });

  frame.src = blobUrl;

  mountToolbar(wrap, {
    file, plan,
    onTheme: (t) => { applyThemeAll(t); },
    onScale: (s) => { applyScaleAll(s); },
  });

  log.info('viewer', `${file.name} (${Math.round(doc.size / 1024)}KB)`
    + ` 수식${plan.mathlive ? 'O' : '-'} 작도${plan.graph ? 'O' : '-'}`);
}

function hideVeil(veil) { veil?.classList.add('gone'); }

function onLink(m, from) {
  if (m.kind === 'external') {
    window.open(m.url, '_blank', 'noopener');
    return;
  }
  const target = catalog.resolveRelative(from, m.href);
  if (target) router.go('#/doc/' + encodeURIComponent(target.id));
  else shell.toast('연결된 문서를 찾지 못했습니다.');
}

/* ── 테마·글자 크기는 셸과 문서가 같은 값을 쓴다 ────────────────────── */
export function applyThemeAll(theme) {
  patch('ui', { theme });
  localStorage.setItem('templum.ui.theme', JSON.stringify(theme));
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  const d = cur?.frame?.contentDocument;
  if (d) applyTheme(d, theme);
}

export function applyScaleAll(scale) {
  patch('ui', { textScale: scale });
  localStorage.setItem('templum.ui.textScale', JSON.stringify(scale));
  const d = cur?.frame?.contentDocument;
  if (d) applyScale(d, scale);
}

/* ── 닫기 ─────────────────────────────────────────────────────────── */
export async function close() {
  document.body.classList.remove('reading');
  if (!cur) return;
  const c = cur;
  cur = null;
  try { c.unlisten?.(); } catch (e) {}
  try { c.frame?.remove(); } catch (e) {}          // 프레임을 통째로 버린다(히스토리 오염 차단)
  try { URL.revokeObjectURL(c.blobUrl); } catch (e) {}
  // 4단계에서: 여기서 답안을 모아 outbox 에 넣는다
}

export function current() { return cur; }
