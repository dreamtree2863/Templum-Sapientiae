/* md5.js — 낭독 타이밍의 지문(sig)을 맞춰 보기 위한 최소 MD5.
 *
 *  왜 MD5 인가: 데스크톱 `tts_common._timing_sig` 가 md5 로 지문을 만든다.
 *  그 값과 같아야 mp3 에 박아 둔 whisper 타이밍을 믿고 쓸 수 있다.
 *  Web Crypto 는 MD5 를 지원하지 않아 직접 둔다. 보안 용도가 아니라 지문 대조용이다.
 */

function toWords(bytes) {
  const n = bytes.length;
  const words = new Array(((n + 8) >> 6) + 1).fill(0).map(() => 0);
  const len = (((n + 8) >> 6) + 1) * 16;
  const w = new Array(len).fill(0);
  for (let i = 0; i < n; i++) w[i >> 2] |= bytes[i] << ((i % 4) * 8);
  w[n >> 2] |= 0x80 << ((n % 4) * 8);
  w[len - 2] = n * 8;
  return w;
}

function add32(a, b) { return (a + b) & 0xffffffff; }
function rol(n, c) { return (n << c) | (n >>> (32 - c)); }

function cmn(q, a, b, x, s, t) { return add32(rol(add32(add32(a, q), add32(x, t)), s), b); }
function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

const K = [
  [ff, 0, 7, -680876936], [ff, 1, 12, -389564586], [ff, 2, 17, 606105819], [ff, 3, 22, -1044525330],
  [ff, 4, 7, -176418897], [ff, 5, 12, 1200080426], [ff, 6, 17, -1473231341], [ff, 7, 22, -45705983],
  [ff, 8, 7, 1770035416], [ff, 9, 12, -1958414417], [ff, 10, 17, -42063], [ff, 11, 22, -1990404162],
  [ff, 12, 7, 1804603682], [ff, 13, 12, -40341101], [ff, 14, 17, -1502002290], [ff, 15, 22, 1236535329],
  [gg, 1, 5, -165796510], [gg, 6, 9, -1069501632], [gg, 11, 14, 643717713], [gg, 0, 20, -373897302],
  [gg, 5, 5, -701558691], [gg, 10, 9, 38016083], [gg, 15, 14, -660478335], [gg, 4, 20, -405537848],
  [gg, 9, 5, 568446438], [gg, 14, 9, -1019803690], [gg, 3, 14, -187363961], [gg, 8, 20, 1163531501],
  [gg, 13, 5, -1444681467], [gg, 2, 9, -51403784], [gg, 7, 14, 1735328473], [gg, 12, 20, -1926607734],
  [hh, 5, 4, -378558], [hh, 8, 11, -2022574463], [hh, 11, 16, 1839030562], [hh, 14, 23, -35309556],
  [hh, 1, 4, -1530992060], [hh, 4, 11, 1272893353], [hh, 7, 16, -155497632], [hh, 10, 23, -1094730640],
  [hh, 13, 4, 681279174], [hh, 0, 11, -358537222], [hh, 3, 16, -722521979], [hh, 6, 23, 76029189],
  [hh, 9, 4, -640364487], [hh, 12, 11, -421815835], [hh, 15, 16, 530742520], [hh, 2, 23, -995338651],
  [ii, 0, 6, -198630844], [ii, 7, 10, 1126891415], [ii, 14, 15, -1416354905], [ii, 5, 21, -57434055],
  [ii, 12, 6, 1700485571], [ii, 3, 10, -1894986606], [ii, 10, 15, -1051523], [ii, 1, 21, -2054922799],
  [ii, 8, 6, 1873313359], [ii, 15, 10, -30611744], [ii, 6, 15, -1560198380], [ii, 13, 21, 1309151649],
  [ii, 4, 6, -145523070], [ii, 11, 10, -1120210379], [ii, 2, 15, 718787259], [ii, 9, 21, -343485551],
];

/** 바이트 배열 → 32자 소문자 16진 md5 */
export function md5Bytes(bytes) {
  const x = toWords(bytes);
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    for (let j = 0; j < 64; j++) {
      const [fn, k, s, t] = K[j];
      if (j % 4 === 0) a = fn(a, b, c, d, x[i + k], s, t);
      else if (j % 4 === 1) d = fn(d, a, b, c, x[i + k], s, t);
      else if (j % 4 === 2) c = fn(c, d, a, b, x[i + k], s, t);
      else b = fn(b, c, d, a, x[i + k], s, t);
    }
    a = add32(a, oa); b = add32(b, ob); c = add32(c, oc); d = add32(d, od);
  }
  return [a, b, c, d].map(hex32).join('');
}

function hex32(n) {
  let s = '';
  for (let i = 0; i < 4; i++) s += ((n >> (i * 8 + 4)) & 15).toString(16) + ((n >> (i * 8)) & 15).toString(16);
  return s;
}

/** 문자열(UTF-8) → md5 16진 */
export function md5(str) {
  return md5Bytes(new TextEncoder().encode(str));
}
