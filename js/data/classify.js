/* classify.js — 파일명 규약을 뜻으로 옮긴다. 순수 함수만 있다.
 *
 *  ‼ 이 규약의 원본은 데스크톱 `study_manager/core/archive_manager.py` 의
 *    `_KNOWN_SUFFIXES` / `SUFFIX_CATEGORY` 다. 한쪽을 고치면 다른 쪽도 고칠 것.
 *
 *  옛 app.js:448-477 에는 학습지(_백지인출·_복기퀴즈)가 빠져 있었다.
 *  지금 폰의 주력 콘텐츠가 그 735편이므로 여기서 채운다.
 */

/* 낭독 오디오 — 데스크톱 core/drive_sync.py:_AUDIO_EXTS 와 맞춘다.
   .flac 은 낭독 조각 캐시라 미러 대상에서 빠졌다(있어도 무시). */
export const AUDIO_RE = /\.(mp3|m4a|wav|ogg|opus|aac|wma)$/i;
export const DOC_RE = /\.html?$/i;

/** 미러에서 우리가 담을 파일인가 — listAllFilesUnder 의 keep 으로 넘긴다. */
export function keepFile(name) {
  return DOC_RE.test(name) || AUDIO_RE.test(name);
}
export function isAudio(name) { return AUDIO_RE.test(name); }

/** 오디오 파일명 → 문서 stem (확장자·'_낭독'/' 낭독' 제거, NFC 소문자) */
export function audioStem(name) {
  return name.replace(AUDIO_RE, '').replace(/(_| )낭독$/, '').normalize('NFC').toLowerCase();
}
/** 문서 파일명 → stem — 오디오와 짝짓는 키 */
export function docStem(name) {
  return name.replace(DOC_RE, '').normalize('NFC').toLowerCase();
}

/** 뒤에 붙는 말 → 무엇인지. 긴 것부터 검사해야 `_종합추출본_요약본` 이 옳게 잡힌다. */
const SUFFIX_MAP = [
  // 학습지 — 폰의 주력
  ['_백지인출.html',      { kind: 'recall',    label: '백지 인출', group: 'work' }],
  ['_복기퀴즈.html',      { kind: 'quiz',      label: '복기 퀴즈', group: 'work' }],
  // 문제(시험) 계열
  ['_요약본.html',        { kind: 'summary',   label: '요약본',    group: 'lib' }],
  ['_종합추출본.html',    { kind: 'q_toc_a',   label: '종합답안',  group: 'lib' }],
  ['_문제목차추출본.html', { kind: 'q_toc',     label: '문제+목차', group: 'lib' }],
  ['_문제추출본.html',    { kind: 'q_only',    label: '문제',      group: 'lib' }],
  ['_객관식추출본.html',  { kind: 'mcq',       label: '객관식',    group: 'review' }],
  ['_시험기준.html',      { kind: 'exam_criteria',    label: '출제 기준', group: 'lib' }],
  ['_채점기준.html',      { kind: 'grading_criteria', label: '채점 기준', group: 'lib' }],
  ['_채점본.html',        { kind: 'graded',    label: '채점본',    group: 'lib' }],
  ['_수기채점본.html',    { kind: 'graded',    label: '수기 채점본', group: 'lib' }],
  ['_모범답안.html',      { kind: 'model',     label: '모범답안',  group: 'lib' }],
  // 쟁점 계열
  ['_쟁점목차.html',      { kind: 'topic_toc',     label: '쟁점목차', group: 'lib' }],
  ['_쟁점본문.html',      { kind: 'topic_body',    label: '쟁점본문', group: 'lib' }],
  ['_쟁점요약.html',      { kind: 'topic_summary', label: '쟁점요약', group: 'lib' }],
  ['_낭독대본.html',      { kind: 'tts_script',    label: '낭독 대본', group: 'lib' }],
  ['_보충대안.html',      { kind: 'supplement',    label: '보충·대안', group: 'lib' }],
  // 리포트 — 목록에 뜨긴 하되 학습 자료와 구분되게
  ['_품질검증.html',      { kind: 'report',        label: '품질 검증', group: 'settings' }],
  ['_정비.html',          { kind: 'report',        label: '정비 리포트', group: 'settings' }],
];

export function classify(file) {
  for (const [sfx, info] of SUFFIX_MAP) {
    if (!file.name.endsWith(sfx)) continue;
    let base = file.name.slice(0, -sfx.length);
    if (info.kind === 'summary') {           // 요약본은 접미사가 두 겹이다
      for (const s2 of ['_종합추출본', '_문제목차추출본', '_문제추출본']) {
        if (base.endsWith(s2)) { base = base.slice(0, -s2.length); break; }
      }
    }
    return { ...info, baseTitle: base };
  }
  // 백과사전 일반 문서 — 접미사 없음
  return { kind: 'plain', label: '열기', group: 'lib',
           baseTitle: file.name.replace(DOC_RE, '') };
}

/* ── 경로가 곧 분류다 ──────────────────────────────────────────────────
 *  옛 코드(app.js:617-647)는 파일명을 정규식으로 *추측*해 분류했다.
 *  Drive 폴더 구조가 이미 정확한 분류이므로 그것을 그대로 쓴다.
 *      archive/백지 인출/경제학/거시경제학 01. …/파일.html
 *              └ 자료종류   └ 과목   └ 단원
 */
export function segments(file) {
  const segs = (file.path || '').split('/').filter(Boolean);
  if (segs[0] === 'encyclopedia') {
    return { root: 'encyclopedia', kindFolder: '백과사전', subject: segs[2] || '', unit: segs[3] || '', rest: segs.slice(4) };
  }
  return { root: segs[0] || '', kindFolder: segs[1] || '', subject: segs[2] || '', unit: segs[3] || '', rest: segs.slice(4) };
}

/** 사람이 읽을 크기. 3MB 넘으면 목록에 "대용량"으로 표시한다. */
export function sizeLabel(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1) + 'MB';
  return Math.round(bytes / 1024) + 'KB';
}
export const isHeavy = (bytes) => bytes > 3 * 1024 * 1024;
