/* doc-rules.js — 이 문서에 무엇을 넣어 줘야 하는가.
 *
 *  ‼‼ 이 파일은 데스크톱 `study_manager/core/math_input.py` 의 짝이다.
 *      한쪽을 고치면 반드시 다른 쪽도 고칠 것. 대응은 이렇다:
 *
 *        needsMath()   ↔ math_input.py:163  needs()
 *        hasDraw()     ↔ math_input.py:96   has_draw()
 *        hasText()     ↔ math_input.py:143  (contenteditable 검사)
 *        subjectOf()   ↔ math_input.py:179  subject_of()
 *        HEAD_BYTES    ↔ math_input.py:125  _head_of(n=400000)
 *        planFor()     ↔ math_input.py:106  doc_js()
 *
 *  판정을 파일 앞 400KB 로만 하는 것도 데스크톱과 같다. 5MB 문서를
 *  통째로 문자열로 만들지 않으려는 조치이기도 하다.
 */

export const HEAD_BYTES = 400_000;

export function needsMath(head) {
  return head.includes('class="mi"') || head.includes("class='mi'")
      || head.includes('name="math-input"') || head.includes('<math-field');
}

export function hasDraw(head) {
  return head.includes('class="write draw"');
}

export function hasText(head) {
  return head.includes('contenteditable');
}

export function hasWorksheet(head) {
  return head.includes('class="write"') || hasDraw(head)
      || head.includes('class="cell"') || head.includes('class="fbi"');
}

/** 문서가 자체 스타일에 기대는가 — iframe 이 필요한 결정적 근거. */
export function hasOwnStyle(head) {
  return /<style[\s>]/i.test(head);
}

export function subjectOf(path) {
  const t = path || '';
  if (/경제|거시|미시|국제금융|국제무역|계량/.test(t)) return 'econ';
  if (/국제법|국제정치|정치학|외교사/.test(t)) return 'intl';
  return '';
}

/** 문서가 상대경로 자산을 참조하는가 — blob: 에서는 풀리지 않는다.
 *  데스크톱이 저장할 때 data URI 로 인라인해 두므로(web_bridge_archive.py:521)
 *  보통은 없지만, 있으면 그 문서만 srcdoc 으로 보낸다. */
export function hasRelativeAsset(head) {
  return /<img[^>]+src=["'](?!data:|https?:|\/\/)[^"']+["']/i.test(head)
      || /<link[^>]+href=["'](?!data:|https?:|\/\/)[^"']+\.css["']/i.test(head);
}

/**
 * 이 문서에 넣어 줄 것들. math_input.py:106 doc_js() 의 분기와 같은 뜻.
 *   mathjax   735편 전부가 \(…\) 를 쓰는데 스크립트를 품고 있지 않다 → 늘 필요
 *   mathlive  수식칸(class="mi") 이 있을 때만. 실측 1편 → 지연 로드
 *   mathInput 수식칸이 있거나, 과목을 아는 문서의 글자칸(유니코드 수식 손버릇)
 *   graph     작도칸(class="write draw") — 실측 232편
 */
export function planFor(path, head) {
  const math = needsMath(head);
  const draw = hasDraw(head);
  const text = hasText(head);
  const subject = subjectOf(path);
  return {
    mathjax: true,
    mathlive: math,
    mathInput: math || (!!subject && text),
    graph: draw,
    subject,
    worksheet: hasWorksheet(head),
    ownStyle: hasOwnStyle(head),
    relative: hasRelativeAsset(head),
  };
}

/** 문서가 답을 저장할 때 쓰는 이름표. 문서 안 IIFE 의 `var PREFIX = '...'` 를 읽는다.
 *  4단계(폰→PC)에서 이 이름표로 답안을 모은다. */
export function prefixOf(tail) {
  const m = /var\s+PREFIX\s*=\s*'([^']+)'/.exec(tail || '');
  return m ? m[1] : null;
}
