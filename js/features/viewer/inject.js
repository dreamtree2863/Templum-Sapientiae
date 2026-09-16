/* inject.js — iframe 안 문서에 필요한 것을 넣어 준다.
 *
 *  ‼ 문서 디자인을 덮어쓰지 않는다. 학습지는 인쇄본과 같은 조판이 살아 있어야 한다.
 *    넣는 것은 "없으면 폰에서 못 쓰는 것"뿐이다.
 *
 *  가장 중요한 한 줄: <meta name="viewport">
 *    학습지 735편 전부에 이게 없다(표본 60/60 확인). 없으면 폰이 문서를
 *    데스크톱 폭(980px)으로 그려서 글자가 깨알같아진다 — 2단계 전체가 무의미해진다.
 */

const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover';

/* 문서 위에 얹는 최소 규칙. 문서 자체 CSS 를 이기지 않도록 조심스럽게 쓴다. */
const SHIM_CSS = `
/* 폰에서 읽을 수 있게 — 글자 크기는 앱 툴바가 --ts 로 조절한다 */
html { -webkit-text-size-adjust: 100%; font-size: var(--ts, 100%); }
/* 화면 밖 요소는 그리지도 디코드하지도 않는다 (base64 그림이 수십 장인 문서 대비) */
img, svg, table, figure { content-visibility: auto; contain-intrinsic-size: 1px 420px; }
/* 넓은 표가 화면을 가로로 밀지 않게 — 표만 제 안에서 옆으로 굴린다.
   학습지 표에는 min-width:560px 가 걸려 있어(열 간격 유지용) 폰 폭 390 을 넘긴다.
   문서가 제공하는 .tablewrap 을 먼저 쓰고, 없으면 표 자체를 블록으로. */
/* 그리드·플렉스 자식은 기본이 min-width:auto 라 "내용보다 작아지길 거부"한다.
   그래서 표 하나가 화면 전체를 밀어낸다. 이 한 줄이 그 고리를 끊는다. */
.sheet > *, .keysheet > *, .item, .tablewrap, .table-wrap { min-width: 0; }
.tablewrap, .table-wrap { max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { max-width: 100%; }
:not(.tablewrap):not(.table-wrap) > table {
  display: block; width: max-content; max-width: 100%; overflow-x: auto; min-width: 0;
}
img, svg, video, canvas { max-width: 100%; height: auto; }
/* 하단 툴바에 본문 끝이 가리지 않게 */
body { padding-bottom: calc(96px + env(safe-area-inset-bottom, 0px)) !important; }
/* 손가락으로 답안칸을 누르기 쉽게 — 최소 높이만 보장하고 문서 조판은 그대로 */
.write { min-height: max(var(--lines, 2) * 1.9em, 56px); }
`;

/** iframe 문서(같은 출처)에 <head> 를 채운다. frame.onload 이후에 부른다. */
export function inject(doc, plan, { theme, textScale } = {}) {
  if (!doc || !doc.head) return;

  ensureViewport(doc);
  applyTheme(doc, theme);
  applyScale(doc, textScale);
  addStyle(doc, 'ge-shim', SHIM_CSS);

  // 순서가 중요하다 — 문서 IIFE 가 window.MathInput / MathfieldElement 를 보고 갈린다.
  // 다만 문서 스크립트는 이미 돌았으므로, 여기 넣는 것은 "있으면 더 좋은" 것들이다.
  if (plan.mathInput) addScript(doc, './vendor/math_input.js');
  if (plan.graph) addScript(doc, './vendor/graph_editor.js');
  if (plan.mathjax) addMathJax(doc);
}

function ensureViewport(doc) {
  let m = doc.querySelector('meta[name="viewport"]');
  if (!m) {
    m = doc.createElement('meta');
    m.name = 'viewport';
    doc.head.insertBefore(m, doc.head.firstChild);
  }
  m.setAttribute('content', VIEWPORT);
}

/** 문서 60/60 편이 :root[data-theme] 를 이미 지원한다 — 값만 심으면 따라온다. */
export function applyTheme(doc, theme) {
  const root = doc.documentElement;
  if (!theme || theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export function applyScale(doc, scale) {
  doc.documentElement.style.setProperty('--ts', Math.round((scale || 1) * 100) + '%');
}

function addStyle(doc, id, css) {
  if (doc.getElementById(id)) return;
  const st = doc.createElement('style');
  st.id = id;
  st.textContent = css;
  doc.head.appendChild(st);
}

function addScript(doc, src, { onload } = {}) {
  const s = doc.createElement('script');
  s.src = new URL(src, location.href).href;      // blob: 문서에서는 절대 URL 이어야 한다
  if (onload) s.onload = onload;
  doc.head.appendChild(s);
  return s;
}

/**
 * MathJax — 문서 735편이 \(…\) 를 쓰는데 스크립트를 품고 있지 않다.
 * 늦게 실어도 startup 이 문서 전체를 조판하므로 후주입으로 충분하다.
 * 폰트도 우리 것을 쓰게 해 오프라인에서 깨지지 않게 한다.
 */
function addMathJax(doc) {
  if (doc.getElementById('mj-config')) return;
  const fontURL = new URL('./vendor/mathjax/es5/output/chtml/fonts/woff-v2', location.href).href;
  const cfg = doc.createElement('script');
  cfg.id = 'mj-config';
  cfg.textContent = `window.MathJax = {
    tex: { inlineMath: [['\\\\(','\\\\)']], displayMath: [['\\\\[','\\\\]'], ['$$','$$']] },
    options: { skipHtmlTags: ['script','noscript','style','textarea','pre','code'] },
    chtml: { fontURL: ${JSON.stringify(fontURL)} },
    startup: { pageReady() {
      return MathJax.startup.defaultPageReady().then(function () {
        try { parent.postMessage({ __templum: 1, t: 'typeset-done' }, '*'); } catch (e) {}
      });
    } }
  };`;
  doc.head.appendChild(cfg);
  addScript(doc, './vendor/mathjax/es5/tex-mml-chtml.js');
}

/** 수식칸이 있는 문서(실측 1편)만 — MathLive 는 824KB 라 그때만 싣는다. */
export function injectMathLive(doc) {
  if (doc.getElementById('ml-lib')) return Promise.resolve(false);
  return new Promise((resolve) => {
    const css = doc.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('./vendor/mathlive/mathlive-static.css', location.href).href;
    doc.head.appendChild(css);
    const s = doc.createElement('script');
    s.id = 'ml-lib';
    s.src = new URL('./vendor/mathlive/mathlive.min.js', location.href).href;
    s.onload = () => {
      try {
        doc.defaultView.MathfieldElement.fontsDirectory =
          new URL('./vendor/mathlive/fonts', location.href).href;
      } catch (e) { /* 없어도 평문 폴백으로 돈다 */ }
      // 문서가 이미 지나간 뒤이므로 우리가 대신 깨운다
      try { doc.defaultView.MathInput?.init?.(); } catch (e) {}
      resolve(true);
    };
    s.onerror = () => resolve(false);
    doc.head.appendChild(s);
  });
}
