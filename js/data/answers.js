/* answers.js — 폰에서 푼 답을 모은다.
 *
 *  학습지 문서는 제 스크립트로 답을 localStorage 에 쓴다(문서 IIFE):
 *      <PREFIX>-cell-<i>      표 빈칸(선택지 순환)
 *      <PREFIX>-<data-key>    글 답안칸(.write)
 *  PREFIX 는 문서마다 다르다(recall-cycle-1, q350 …). doc-rules.prefixOf 가 캔다.
 *
 *  ‼ 문서를 고치지 않는다. 문서는 제 방식대로 저장하고, 우리는 그 자리를 읽을 뿐이다.
 *    iframe 은 blob: 이라 출처가 앱과 같다 — 그래서 같은 localStorage 를 본다.
 *
 *  ‼ 답안을 **병합하지 않는다.** `.write` 는 통짜 문자열이라 두 쪽을 합칠 방법이 없다.
 *    폰은 "이 시점의 답"을 사건으로 보내고, PC 가 배너로 보여 주고 사람이 고른다.
 */
import * as log from '../core/log.js';

/** 이 문서의 답을 모두 읽는다. 빈 칸은 담지 않는다. */
export function collect(prefix) {
  const out = {};
  if (!prefix) return out;
  const head = prefix + '-';
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(head)) continue;
      const v = localStorage.getItem(k);
      if (v) out[k.slice(head.length)] = v;
    }
  } catch (e) { log.warn('answers', '답안을 읽지 못했습니다', e); }
  return out;
}

/** 내용이 바뀌었는지 싸게 가리는 지문. 같으면 보내지 않는다. */
export function signature(values) {
  const keys = Object.keys(values).sort();
  let h = 0x811c9dc5;
  const feed = (s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  feed(String(keys.length));
  for (const k of keys) { feed(k); feed(''); feed(values[k]); feed(''); }
  return h.toString(16);
}

/** PC 로 보낼 사건 하나. 상태가 아니라 **사건**이라 두 번 들어와도 같은 결과다. */
export function event(file, prefix, values) {
  return {
    kind: 'answers',
    docId: file.id,
    name: file.name,
    path: file.path,
    prefix,
    at: Date.now(),
    count: Object.keys(values).length,
    values,
  };
}
