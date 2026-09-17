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
import { catalog, docContent, docRules, markOpened, captureAnswers } from '../../data/index.js';
import { inject, injectMathLive, applyTheme, applyScale } from './inject.js';
import * as bridge from './frame-bridge.js';
import { mountToolbar, setPlayState } from './toolbar.js';
import * as tts from '../tts/player.js';

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
    /* ‼ 답안은 문서가 제 손으로 읽어 보내 준다(부모가 자기 localStorage 를 뒤지지 않는다).
       blob: 문서가 부모와 다른 출처로 잡히는 브라우저가 있어, 부모 쪽은 텅 비어
       "보낼 게 없다"가 되던 문제를 여기서 막는다. */
    answers: (m) => {
      if (!cur) return;
      cur.answers = m.values || {};
      if (m.prefix) cur.prefix = m.prefix;
      harvest(cur);
    },
  });

  frame.addEventListener('load', () => {
    const d = frame.contentDocument;
    if (!d) { hideVeil(veil); return; }
    try {
      inject(d, plan, { theme: ui.theme, textScale: ui.textScale });
      bridge.installAgent(d, { prefix: doc.prefix });
      if (plan.mathlive) injectMathLive(d);
    } catch (e) {
      log.warn('viewer', '자산 주입 실패', e);
    }
    // MathJax 가 조판을 끝냈다고 알려 주기 전에도 오래 가리지 않는다
    setTimeout(() => hideVeil(veil), plan.mathjax ? 6000 : 400);
  }, { once: true });

  frame.src = blobUrl;

  // ‼ 폰은 언제든 죽는다 — 닫을 때만 거두면 홈 버튼 한 번에 답이 날아간다.
  //   화면이 가려지는 순간에도 거둔다(그때가 마지막 기회일 수 있다).
  if (plan.worksheet) {
    cur.onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      bridge.ask(frame, 'collect');          // 마지막 타이핑까지 달라고 한다
      harvest();
    };
    document.addEventListener('visibilitychange', cur.onHide);
  }

  const bar = mountToolbar(wrap, {
    file, plan,
    onTheme: (t) => { applyThemeAll(t); },
    onScale: (s) => { applyScaleAll(s); },
    onPlay: () => onPlay(frame, file, bar),
  });

  log.info('viewer', `${file.name} (${Math.round(doc.size / 1024)}KB)`
    + ` 수식${plan.mathlive ? 'O' : '-'} 작도${plan.graph ? 'O' : '-'}`);
}

function hideVeil(veil) { veil?.classList.add('gone'); }

/** 이 문서의 답안을 거둬 큐에 넣는다(바뀐 게 있을 때만).
 *  ‼ 맥락을 **인자로** 받는다 — close() 는 cur 를 비운 뒤에 부르기 때문에
 *    전역을 보게 두면 정작 떠날 때 아무것도 못 거둔다. */
function harvest(c = cur) {
  if (!c || !c.plan?.worksheet || !c.prefix) return;
  captureAnswers(c.file, c.prefix, c.answers)
    .catch(e => log.warn('viewer', '답안 수집 실패', e));
}

/* 낭독 — 문서를 보며 따라 읽는다. 처음 누를 때만 붙이고, 그 뒤엔 재생/일시정지. */
async function onPlay(frame, file, bar) {
  if (tts.current()?.file?.id === file.id) { tts.toggle(); return; }
  setPlayState(bar, 'loading');
  const ok = await tts.attach(file, frame, { onState: (st) => setPlayState(bar, st) });
  if (!ok) { setPlayState(bar, 'stopped'); shell.toast('낭독을 열지 못했습니다'); return; }
  tts.start();
}

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
  harvest(c);                                      // 떠나기 전에 답을 거둔다(cur 는 이미 비었다)
  try { document.removeEventListener('visibilitychange', c.onHide); } catch (e) {}
  try { tts.stop(); } catch (e) {}                 // 문서를 떠나면 소리도 멈춘다
  try { c.unlisten?.(); } catch (e) {}
  try { c.frame?.remove(); } catch (e) {}          // 프레임을 통째로 버린다(히스토리 오염 차단)
  try { URL.revokeObjectURL(c.blobUrl); } catch (e) {}
}

export function current() { return cur; }
