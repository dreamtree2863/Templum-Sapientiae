/* log.js — 진단 로그 링버퍼.
 *
 *  폰에는 개발자 도구를 열기 어렵다. 동기화가 조용히 실패하면
 *  "공부한 게 사라졌다"는 인상만 남는다. 그래서 최근 기록을 앱 안에 남겨
 *  ⚙️ 설정 화면에서 바로 볼 수 있게 한다.
 */
const MAX = 200;
const buf = [];

function push(level, tag, msg, extra) {
  const line = {
    t: Date.now(), level, tag,
    msg: String(msg),
    extra: extra === undefined ? undefined
      : (extra instanceof Error ? (extra.stack || extra.message) : safeJson(extra)),
  };
  buf.push(line);
  if (buf.length > MAX) buf.shift();
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${tag}]`, msg, extra === undefined ? '' : extra);
  return line;
}

function safeJson(v) {
  try { const s = JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + '…' : s; }
  catch (e) { return String(v); }
}

export const info = (tag, msg, extra) => push('info', tag, msg, extra);
export const warn = (tag, msg, extra) => push('warn', tag, msg, extra);
export const error = (tag, msg, extra) => push('error', tag, msg, extra);

export function recent(n = 50) { return buf.slice(-n).reverse(); }
export function clear() { buf.length = 0; }

/** 설정 화면에서 통째로 복사해 붙일 수 있게. */
export function dump() {
  return buf.map(l => {
    const ts = new Date(l.t).toISOString().slice(11, 19);
    return `${ts} ${l.level.toUpperCase().padEnd(5)} [${l.tag}] ${l.msg}` +
           (l.extra ? `\n      ${l.extra}` : '');
  }).join('\n');
}
