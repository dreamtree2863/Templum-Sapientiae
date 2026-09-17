/* frame-bridge.js — 부모 ↔ iframe 사이의 약속.
 *
 *  blob: 문서는 부모와 같은 출처라 contentDocument 로 직접 만질 수도 있지만,
 *  스크롤·링크처럼 문서 안에서 벌어지는 일은 안에서 듣는 편이 싸고 정확하다.
 *  그래서 작은 스크립트 하나를 문서에 심고 postMessage 로 주고받는다.
 *
 *  주고받는 것 (전부 {__templum:1, t:...} 꼴)
 *    iframe → 부모   scroll · link · typeset-done · answers
 *    부모 → iframe   scroll-to · collect
 *
 *  ‼ 답안은 **문서가 직접 읽어서 보낸다.** 부모가 자기 localStorage 를 뒤지면 안 된다 —
 *    blob: 문서가 부모와 다른 출처로 잡히는 브라우저가 있고(폰에서 실제로 겪었다),
 *    그러면 부모 쪽은 텅 비어 "보낼 게 없다"가 된다. 문서에게 물어보면 그 문제가 없다.
 */

const TAG = '__templum';

/** iframe 안에서 돌 스크립트. 문자열로 넣는다(같은 출처라 그냥 실행된다). */
const AGENT = `(function () {
  var send = function (m) { try { parent.postMessage(Object.assign({ ${TAG}: 1 }, m), '*'); } catch (e) {} };

  // 스크롤 위치 — 되돌아왔을 때 읽던 자리로
  var last = 0, timer = null;
  addEventListener('scroll', function () {
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      var y = window.scrollY || document.documentElement.scrollTop || 0;
      if (Math.abs(y - last) < 24) return;
      last = y;
      send({ t: 'scroll', y: y, h: document.documentElement.scrollHeight });
    }, 250);
  }, { passive: true });

  // 링크 — 문서 안 목차(#)는 그대로, 나머지는 부모가 판단한다
  addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#') return;                       // 내부 목차 — 기본 동작
    e.preventDefault();
    if (/^https?:/i.test(href) || a.target === '_blank') send({ t: 'link', kind: 'external', url: href });
    else send({ t: 'link', kind: 'doc', href: href });
  }, true);

  /* 답을 저장하는 자리(PREFIX)는 **부모가 넣어 준다**.
     주의: 이 스크립트는 템플릿 문자열이라 역슬래시가 한 겹 먹힌다. 여기서 정규식으로
     다시 캐려다 백슬래시-s 가 조용히 s 가 되어 아무것도 못 찾았다(실제로 물렸다).
     캐는 일은 doc-rules.prefixOf 한 곳에서만 한다. */
  var PREFIX = __PREFIX__;

  function collect() {
    var out = {};
    if (!PREFIX) return out;
    var head = PREFIX + '-';
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(head) !== 0) continue;
        var v = localStorage.getItem(k);
        if (v) out[k.slice(head.length)] = v;
      }
    } catch (e) {}
    return out;
  }

  function sendAnswers() { send({ t: 'answers', prefix: PREFIX, values: collect() }); }

  // 답이 바뀌면 그 자리에서 값까지 함께 보낸다 — 부모가 늘 최신 사본을 들고 있게
  var dirty = null;
  addEventListener('input', function () {
    if (dirty) return;
    dirty = setTimeout(function () { dirty = null; sendAnswers(); }, 1200);
  }, true);
  // 표 빈칸은 클릭으로 순환하므로 input 이 안 난다
  addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('cell')) return;
    if (dirty) clearTimeout(dirty);
    dirty = setTimeout(function () { dirty = null; sendAnswers(); }, 1200);
  }, true);

  addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.${TAG}) return;
    if (d.t === 'scroll-to') window.scrollTo(0, d.y || 0);
    if (d.t === 'collect') sendAnswers();
  });

  send({ t: 'agent-ready' });
})();`;

export function installAgent(doc, { prefix } = {}) {
  const s = doc.createElement('script');
  // 답 저장 자리는 부모가 이미 안다(doc-rules.prefixOf) — 문서에 그대로 심어 준다
  s.textContent = AGENT.replace('__PREFIX__', JSON.stringify(prefix || null));
  (doc.body || doc.documentElement).appendChild(s);
}

/** 부모 쪽 수신기. 반환: 해제 함수 */
export function listen(frame, handlers) {
  function onMsg(e) {
    const d = e.data;
    if (!d || !d[TAG]) return;
    if (frame && e.source !== frame.contentWindow) return;    // 남의 프레임 메시지 무시
    handlers[d.t]?.(d);
  }
  window.addEventListener('message', onMsg);
  return () => window.removeEventListener('message', onMsg);
}

export function scrollTo(frame, y) {
  try { frame.contentWindow.postMessage({ [TAG]: 1, t: 'scroll-to', y }, '*'); } catch (e) {}
}

/** 문서에게 무언가를 부탁한다(지금은 'collect' — 답안을 지금 보내 줘). */
export function ask(frame, t, extra) {
  try {
    frame?.contentWindow?.postMessage({ [TAG]: 1, t, ...(extra || {}) }, '*');
  } catch (e) { /* 프레임이 이미 사라졌을 수 있다 */ }
}
