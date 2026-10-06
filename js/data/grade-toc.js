/* grade-toc.js — 폰에서 목차 인출을 채점한다.
 *
 *  ‼ PC 의 OutlineQuizWorker(study_manager/ui/web_bridge_workers.py)와 **같은 프롬프트·같은 셈**이다.
 *    한쪽만 고치면 폰과 PC 점수가 어긋난다 — 고칠 때는 둘 다.
 *      · rubric : `_채점기준.html` 의 배점 논점마다 반영(yes)·부분(partial)·누락(no) 판정 → 배점 합산
 *                 (yes 1 · partial 0.5 · no 0, 가점은 문항 만점 안에서만 보탠다). 점수는 AI 가 아니라 여기서 센다.
 *      · toc    : `_문제목차추출본.html` 의 모범 목차와 비교 (커버리지 70% + 구조 30%, AI 가 점수)
 *
 *  채점 근거 파일은 Drive 미러(archive/…)에서 받는다 — 문제와 같은 과목·같은 이름(base).
 */
import * as catalog from './catalog.js';
import * as classify from './classify.js';
import * as docContent from './doc-content.js';
import { askJson } from './search.js';

const RATE = { yes: 1, partial: 0.5, no: 0 };

/** 문제 파일 → 같은 문제의 채점기준·목차본·종합본 파일(목록에서 찾는다). */
export function siblingsOf(problemFile) {
  const info = classify.classify(problemFile);
  const subj = classify.segments(problemFile).subject;
  const out = { base: info.baseTitle, subject: subj, rubric: null, toc: null, combined: null };
  for (const f of catalog.files()) {
    if (!f.name.startsWith(info.baseTitle)) continue;           // 싸게 먼저 거른다
    const c = classify.classify(f);
    if (c.baseTitle !== info.baseTitle || classify.segments(f).subject !== subj) continue;
    if (c.kind === 'grading_criteria') out.rubric = f;
    else if (c.kind === 'q_toc') out.toc = f;
    else if (c.kind === 'q_toc_a') out.combined = f;
  }
  return out;
}

async function textOfFile(file) {
  const d = await docContent.fetchDoc(file);
  return d.blob.text();
}

/** `_채점기준.html` → 데이터 ({questions:[…]}) · 못 읽으면 null */
export async function loadRubric(file) {
  const html = await textOfFile(file);
  const m = /<script[^>]*id=["']rubric-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    return (r && Array.isArray(r.questions) && r.questions.length) ? r : null;
  } catch (e) { return null; }
}

/** 배점 합계(필수+부가) — 답안 분량 목표(10점당 700~800자)에 쓴다. */
export function totalPoints(rub) {
  return (rub?.questions || []).reduce((s, q) => s + (Number(q.total_points) ||
    (q.items || []).filter(it => it.category !== '가점').reduce((a, it) => a + (Number(it.points) || 0), 0)), 0);
}

/* 모든 <div class="toc"> 블록을 중첩 div 포함 통째로 (데이터 층은 DOM 을 쓰지 않는다 — 문자열로 센다).
   ‼ 비탐욕 정규식 하나로 자르면 첫 안쪽 </div> 에서 끊긴다(PC 에서 실제로 목차 264편이 잘렸다). */
function extractToc(html) {
  const out = [];
  const open = /<div\b[^>]*class=["'][^"']*\btoc\b[^"']*["'][^>]*>/gi;
  let m;
  while ((m = open.exec(html))) {
    const tag = /<\/?div\b[^>]*>/gi;
    tag.lastIndex = m.index + m[0].length;
    let depth = 1, t, end = html.length;
    while ((t = tag.exec(html))) {
      depth += t[0][1] === '/' ? -1 : 1;
      if (depth === 0) { end = t.index + t[0].length; break; }
    }
    out.push(html.slice(m.index, end));
    open.lastIndex = end;
  }
  if (out.length) return out.join('\n').slice(0, 30000);
  const b = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return (b ? b[1] : html).slice(0, 30000);
}

const g = (n) => {               // 12 → "12", 2.5 → "2.5" (파이썬 :g 와 같게)
  const x = Number(n) || 0;
  return String(Math.round(x * 10) / 10);
};

function rubricPrompt(rub, subject, outline) {
  const lines = [];
  rub.questions.forEach((q, qi) => {
    lines.push(`## Q${qi} ${q.id || ''} ${q.title || ''} (총 ${g(q.total_points)}점)`);
    (q.items || []).forEach((it, ii) => {
      let s = `- [Q${qi}-${ii}] (${it.category || ''}, ${g(it.points)}점) ${it.criterion || ''}`;
      if (it.details) s += ` | 포함 요소: ${it.details}`;
      if (it.caution) s += ` | 주의: ${it.caution}`;
      lines.push(s);
    });
  });
  return `당신은 ${subject || '논술'} 답안의 *목차(개요)* 채점관입니다. 학생은 문제만 보고 답안 목차를 백지에서 인출했습니다.\n`
    + '아래 채점 기준(RUBRIC)의 배점 논점마다 학생 목차(USER_OUTLINE)가 그 논점을 *목차 항목으로* 세웠는지 판정해 JSON 만 출력하세요.\n'
    + '마크다운 코드펜스/설명 금지.\n\n'
    + '{\n'
    + '  "items": [{"id": "Q0-0", "verdict": "yes|partial|no", "matched": "대응하는 학생 목차 항목(없으면 빈 문자열)", "note": "판정 근거 한 줄"}, ...],\n'
    + '  "summary": "1~3문장 총평 (구조·순서·배점 배분 포함)",\n'
    + '  "extra": ["채점 기준에 대응하지 않는 학생 목차 항목", ...]\n'
    + '}\n\n'
    + '판정 기준:\n'
    + '- 목차는 제목 수준이므로 서술 깊이·논증 상세는 요구하지 않는다. 그 논점을 다룰 항목이 *명시적으로* 세워졌는가를 본다.\n'
    + '- yes: 해당 논점이 독립 항목(또는 분명한 하위 항목)으로 정확히 세워짐.\n'
    + '- partial: 상위 항목에 뭉뚱그려져 있거나, 핵심어 일부만 있거나, 엉뚱한 문항·위치에 배치됨.\n'
    + "- no: 없음, 또는 인접하지만 다른 개념·이론·학자·판례·조문으로 대체함(인접 개념을 동치로 보지 말 것 — '주의' 란을 반드시 반영).\n"
    + '- 모든 논점 id 에 대해 빠짐없이 하나씩 판정한다.\n\n'
    + '=== RUBRIC ===\n' + lines.join('\n') + '\n\n'
    + `=== USER_OUTLINE ===\n${outline}\n`;
}

function tocPrompt(modelToc, outline) {
  return '당신은 한국어 논술 답안의 *개요(목차)* 평가관입니다.\n'
    + '모범 목차(MODEL_TOC) 와 학생이 백지에서 인출한 목차(USER_OUTLINE) 를 비교하여 다음 JSON 만 출력하세요.\n'
    + '마크다운 코드펜스/설명 금지.\n\n'
    + '{\n'
    + '  "score": 0~100 정수,\n'
    + '  "summary": "1~3문장 총평",\n'
    + '  "covered": ["학생이 잘 다룬 목차 항목", ...],\n'
    + '  "missing": ["학생이 누락한 모범 목차 항목", ...],\n'
    + '  "extra":   ["모범 목차에 없는 학생의 추가 항목", ...]\n'
    + '}\n\n'
    + '평가 기준:\n'
    + '- 단순 단어 일치가 아니라 *개념적 동치* 로 판단. 단, 인접하지만 다른 개념(다른 학자·이론·판례·조문)은 동치로 보지 않는다.\n'
    + '- 모범 목차가 여러 문항(제1문·제2문…)이면 문항별로 대응시켜 비교하고, 항목 앞에 [제N문] 을 붙인다.\n'
    + '- 모범 목차의 깊이/순서를 어느 정도 반영했는지 함께 고려.\n'
    + '- score 는 모범 목차 항목 중 학생이 다룬 비율을 기본 70%, 구조 일치도 30% 가중치로 산정.\n\n'
    + `=== MODEL_TOC ===\n${modelToc}\n\n`
    + `=== USER_OUTLINE ===\n${outline}\n`;
}

const strList = (v) => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : [];

/** 채점. criterion = 'rubric' | 'toc'. 반환은 PC 결과와 같은 모양. */
export async function grade({ criterion, rubricFile, tocFile, subject, outline, onProgress }) {
  if (criterion === 'rubric') {
    onProgress?.('채점 기준을 받는 중…');
    const rub = await loadRubric(rubricFile);
    if (!rub) throw new Error('채점 기준 데이터를 읽지 못했습니다.');
    onProgress?.('AI 가 배점 논점별로 목차를 판정 중…');
    const parsed = await askJson(rubricPrompt(rub, rub.subject || subject, outline));
    const verdicts = {};
    for (const v of (Array.isArray(parsed.items) ? parsed.items : [])) {
      if (v && v.id) verdicts[String(v.id).trim().replace(/^\[|\]$/g, '')] = v;
    }
    const breakdown = [], covered = [], missing = [];
    let earnedAll = 0, maxAll = 0;
    rub.questions.forEach((q, qi) => {
      const qlabel = String(q.id || `제${qi + 1}문`);
      const rows = [];
      let qe = 0, qm = 0;
      (q.items || []).forEach((it, ii) => {
        const v = verdicts[`Q${qi}-${ii}`] || {};
        let verdict = String(v.verdict || 'no').toLowerCase().trim();
        if (!(verdict in RATE)) verdict = 'no';
        const pts = Number(it.points) || 0;
        const got = pts * RATE[verdict];
        const bonus = it.category === '가점';
        if (!bonus) qm += pts;
        qe += got;
        rows.push({ category: it.category || '', points: pts, earned: got, criterion: it.criterion || '',
                    verdict, matched: String(v.matched || ''), note: String(v.note || '') });
        const label = `[${qlabel}] ${it.criterion || ''} (${g(pts)}점)`;
        if (verdict === 'yes') covered.push(label);
        else if (verdict === 'partial') missing.push('△ 부분 — ' + label);
        else if (!bonus) missing.push(label);
      });
      if (qm) qe = Math.min(qe, qm);
      earnedAll += qe; maxAll += qm;
      breakdown.push({ id: qlabel, title: q.title || '', earned: Math.round(qe * 10) / 10,
                       max: Math.round(qm * 10) / 10, items: rows });
    });
    const score = maxAll ? Math.round(100 * earnedAll / maxAll) : 0;
    return { criterion, score: Math.max(0, Math.min(100, score)), summary: parsed.summary || '',
             covered, missing, extra: strList(parsed.extra),
             points_earned: Math.round(earnedAll * 10) / 10, points_max: Math.round(maxAll * 10) / 10,
             breakdown, rubric: rub };
  }
  onProgress?.('모범 목차를 받는 중…');
  const modelToc = extractToc(await textOfFile(tocFile));
  onProgress?.('AI 가 모범 목차와 비교 중…');
  const parsed = await askJson(tocPrompt(modelToc, outline));
  let score = Math.round(Number(parsed.score) || 0);
  return { criterion: 'toc', score: Math.max(0, Math.min(100, score)), summary: parsed.summary || '',
           covered: strList(parsed.covered), missing: strList(parsed.missing), extra: strList(parsed.extra),
           model_toc_html: modelToc };
}

/** 결과 → 복습에 넣을 논점 묶음 (PC toc_quiz.js reviewGroups 와 같은 규칙) */
export function reviewGroups(res) {
  if (res.criterion === 'rubric') {
    return (res.breakdown || []).map(q => ({
      qid: q.id, qtitle: q.title || '',
      items: (q.items || []).filter(it => it.verdict !== 'yes').map(it => ({
        text: it.criterion,
        tag: (it.verdict === 'partial' ? '△ 부분' : '❌ 누락') + ` · ${it.category} ${g(it.points)}점`,
        checked: !(it.category === '가점' && it.verdict === 'no'),
      })),
    })).filter(x => x.items.length);
  }
  const groups = {}, order = [];
  for (const m of (res.missing || [])) {
    const mm = /^\s*\[([^\]]+)\]\s*(.*)$/.exec(m);
    const qid = mm ? mm[1] : '';
    if (!groups[qid]) { groups[qid] = { qid, qtitle: '', items: [] }; order.push(qid); }
    groups[qid].items.push({ text: mm ? mm[2] : m, tag: '❌ 누락', checked: true });
  }
  return order.map(k => groups[k]);
}
