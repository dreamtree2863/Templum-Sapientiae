/* frame-bridge.js — 부모 ↔ iframe 사이의 약속.
 *
 *  blob: 문서는 부모와 같은 출처라 contentDocument 로 직접 만질 수도 있지만,
 *  스크롤·링크처럼 문서 안에서 벌어지는 일은 안에서 듣는 편이 싸고 정확하다.
 *  그래서 작은 스크립트 하나를 문서에 심고 postMessage 로 주고받는다.
 *
 *  주고받는 것 (전부 {__templum:1, t:...} 꼴)
 *    iframe → 부모   scroll · link · typeset-done · answers-changed
 *    부모 → iframe   scroll-to
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

  // 답이 바뀌었다 — 4단계에서 폰→PC 로 보낼 거리가 생겼다는 뜻
  var dirty = null;
  addEventListener('input', function () {
    if (dirty) return;
    dirty = setTimeout(function () { dirty = null; send({ t: 'answers-changed' }); }, 1200);
  }, true);

  addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.${TAG}) return;
    if (d.t === 'scroll-to') window.scrollTo(0, d.y || 0);
  });

  send({ t: 'agent-ready' });
})();`;

export function installAgent(doc) {
  const s = doc.createElement('script');
  s.textContent = AGENT;
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
