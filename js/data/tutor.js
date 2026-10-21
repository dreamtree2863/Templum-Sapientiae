/* tutor.js — 학습 챗봇(데스크톱 study_manager/core/review_chat.py 의 폰판). 데이터 층 — DOM 없음.
 *
 *  모드(무엇을)  ask=자유 학습 · quiz=퀴즈 · recall=암기 확인
 *  범위(무엇으로) due=오늘 복습(복습 카드) · subject=과목(약점+문서 표본) · topic=주제(검색 자료) · doc=문서 하나
 *
 *  ‼ 규칙 문구는 데스크톱 review_chat 과 같다 — 고칠 때 둘 다. 폰은 그래프 설계(```graph)를 그리지 못해
 *    그 부분만 '말·표로 설명'으로 바꿨다.
 *  ‼ 판정 [[GRADE …]] → 기존 카드는 review.grade(PC 와 같은 주기 계산), 카드 없는 누락은
 *    outbox 'tutor.gap' → PC review_chat.apply_remote_tutor_gaps (PC exe 가 먼저 그 처리기를 가져야 한다).
 */
import * as gemini from './gemini.js';
import * as search from './search.js';
import * as review from './review.js';
import * as outbox from './outbox.js';
import * as catalog from './catalog.js';
import * as docContent from './doc-content.js';
import * as idb from '../core/idb.js';
import * as log from '../core/log.js';

export const SUBJECTS = ['국제법', '국제정치학', '경제학'];
export const MODES = { ask: '자유 학습', quiz: '퀴즈', recall: '암기 확인' };
const HISTORY_TURNS = 16;
const DOC_CAP = 20000;
const SAMPLE_CAP = 5000;
export const VOICE_DOC_CAP = 12000;

/* ── 규칙 (데스크톱과 같은 문구) ───────────────────────────────────── */
const BASE_RULES = (
  '당신은 외무고시(외교관후보자 선발시험) 2차 논술 수험생 한 사람을 맡은 학습 튜터입니다. '
  + '과목은 국제법·국제정치학·경제학. 목적은 이 학습자와 *실제로 대화하며* 이해와 기억을 키우는 것입니다 — '
  + '설명·정리·퀴즈·암기 확인·복습 무엇이든 학습자가 원하는 방식으로.\n'
  + '대화 태도:\n'
  + '- 학습자가 방금 한 말에 먼저 반응한다. 질문·반론·하소연·잡담·요청(다시 설명, 예시, 비교표, 더 쉽게/어렵게, '
  + '주제 바꾸기, 잠깐 쉬기)이 오면 그것을 우선해 자연스럽게 응하고, 퀴즈·계획으로 돌아가는 건 그다음이다. '
  + '규칙을 기계적으로 적용하지 말고 상황에 맞게 판단한다.\n'
  + '- 말투는 따뜻하고 담백한 선배 튜터처럼. 짧은 공감·격려는 해도 되지만 과장된 칭찬·형식적 인사는 하지 않는다.\n'
  + '- 답의 길이는 필요만큼: 확인은 짧게, 설명을 청하면 충분히. 폰 화면이니 문단을 짧게 끊는다.\n'
  + '- 학습자의 답이 표현은 달라도 뜻이 맞으면 맞다고 인정한다. 오답을 지적할 때는 왜 그렇게 생각했을지 짚어 준다.\n'
  + '- 확실하지 않은 질문이면 되물어 확인해도 된다.\n'
  + '정확성 — 환각 금지 (무엇보다 중요):\n'
  + '- 근거는 아래 [자료]를 우선한다. 자료에 있는 내용은 자료의 표현·구분을 따른다. '
  + '자료와 일반지식이 충돌하면 자료를 따르되 차이를 지적한다.\n'
  + '- 자료에 없는 내용은 *교과서 수준으로 널리 확립된 것만* 보충한다. 그런 단락·항목은 그 끝에 한 번만 '
  + "'(일반지식)'을 단다 — 문장마다 붙이지 않는다. 답 전체가 자료 밖이면 첫머리에 한 줄로 "
  + "'자료에 없는 내용이라 일반지식으로 답합니다'라고 밝힌다.\n"
  + '- **고유 사실은 절대 지어내지 않는다**: 판례·사건명, 조약명·조문 번호, 연도, 학자·저서명, 수치·통계, 인용문. '
  + "자료에 없고 확실하지 않으면 쓰지 않는다. 꼭 언급해야 하면 '(확인 필요)'를 붙인다. "
  + '그럴듯한 이름·번호·연도를 만들어 내는 것이 가장 나쁜 오류다.\n'
  + "- 모르면 모른다고 말한다. '자료에서 확인되지 않습니다'가 틀린 단정보다 낫다.\n"
  + '- 학습자 답을 판정할 때도 같은 기준: 자료나 확실한 지식으로 뒷받침되는 것만 맞다·틀리다로 단정하고, '
  + '근거가 불확실하면 판정을 유보하고 그 사실을 밝힌다(GRADE 태그도 달지 않는다).\n'
  + '- 용어·고유명사는 정확한 표기로 쓴다(오타·깨진 단어 금지). 영문 병기는 확실할 때만.\n'
  + '표현(폰 화면):\n'
  + '- 그래프는 그리지 않는다(코드블록·SVG 금지). 필요하면 축·곡선·이동 방향·교점·면적을 말이나 표로 설명한다.\n'
  + '- 수식은 \\( … \\) 로 쓴다. 답안 관점(목차 Ⅰ/1/(1), 쟁점·요건·결론)을 살린다. 굵게·목록·표 사용 가능.\n'
);

const QUIZ_RULES = (
  '\n[퀴즈 — 이 대화의 기본 흐름(학습자가 원하면 언제든 벗어나도 된다)]\n'
  + '- 문제는 [범위]의 자료에서 낸다. 아래 [문제 형식] 중 학습자가 고른 형식으로, 말이 없으면 짧은 형식을 섞어서.\n'
  + '- 인출 연습: 한 번에 질문 하나. 먼저 스스로 꺼내게 한다(정의·요건·논거·판례·학설 대립·그래프 해석·답안 목차 등). '
  + "새 문제는 '**Q.**' 로 시작하고 범위를 괄호로 짧게.\n"
  + '- 답을 들으면 맞은 것과 빠진 것을 구체적으로. 부족하면 바로 정답을 주기보다 힌트로 한 번 더 기회를 주는 편이 좋다'
  + '(학습자가 정답을 원하거나 지쳐 보이면 바로 알려 줘도 된다). 알려 줄 때는 요지 3~5줄 + 기억 단서(두문자·연결 고리·대비표).\n'
  + "- 잘 맞히면 '왜/어떻게/만약' 질문이나 다른 개념과의 비교로 넓히고, 난이도를 올린다. 자주 틀리면 기초로 내려간다. "
  + '같은 주제만 계속 묻지 말고 섞는다.\n'
  + '- 학습자가 개념을 물으면 퀴즈를 멈추고 충분히 설명한 뒤, 이해했는지 가볍게 확인하고 원할 때 다시 문제로.\n'
  + "- 학습자가 '정리'·'그만'·'끝'이라고 하면 세션 정리: 잘 꺼낸 것·다시 볼 것(구체 항목)·다음 복습 때 먼저 볼 것.\n"
  + '- 기록용 태그: 한 문항에 대한 *최종* 판단이 났을 때만 응답 마지막 줄에 '
  + '[[GRADE id=<약점 id 또는 new> pct=<0~100 재현율> q="질문 요지 20자 이내"]] 를 한 줄로 단다. '
  + "힌트를 준 중간 단계, 설명·잡담, 세션 정리에는 달지 않는다. '모르겠다'는 pct=0.\n"
);

const QUIZ_FORMATS = (
  '\n[문제 형식 — 학습자가 고르면 그대로, 말이 없으면 섞어서]\n'
  + '- OX: 진술 하나 → O/X 와 이유 한 줄을 요구한다.\n'
  + '- 객관식: 보기 4~5개(①~⑤), 그럴듯한 오답을 넣고 정답은 하나.\n'
  + '- 빈칸: 정의·요건·조문·판례 요지 문장에서 핵심어를 ___ 로 비운다.\n'
  + '- 단답: 용어·판례명·학자·요건 하나를 묻는다.\n'
  + '- 서술·목차: 소논점 2~3개나 답안 목차(Ⅰ/1/(1))를 요구한다.\n'
  + "- 여러 문제를 한 번에 원하면(예: 'OX 5문제') 번호를 매겨 한꺼번에 내고, 한꺼번에 답하면 번호별로 채점해 "
  + '맞힌 수와 틀린 것의 바른 답·이유를 준다(이때 GRADE 태그는 문항마다 한 줄씩).\n'
);

const RECALL_RULES = (
  '\n[암기 확인 — 이 대화의 기본 흐름(학습자가 원하면 언제든 벗어나도 된다)]\n'
  + '- 목적: 외운 것을 *단서 없이* 꺼내게 하고 [자료]와 대조해 빠진 것·틀린 것을 정확히 짚는다.\n'
  + '- 한 번에 한 항목: 개념 정의, 요건·효과, 학설 대립, 판례 요지(사실·쟁점·판시), 조문, 답안 목차, 그래프 설명 등. '
  + "'**R.**' 로 시작해 무엇을 꺼낼지와 범위를 짧게 말하고, 답의 단서가 되는 말은 넣지 않는다.\n"
  + '- 학습자가 꺼내면 [자료] 기준으로 요소별 대조: ✓ 재현 / △ 부분 / ✗ 누락 / ⚠ 부정확 — 요소 목록으로 짧게. '
  + '표현이 달라도 뜻이 맞으면 ✓. 자료에 없는 요소를 정답처럼 요구하지 않는다.\n'
  + '- 대조 뒤 놓친 요소만 골라 곧바로 짧게 다시 묻는다(재인출). 두 번째에도 놓치면 요지와 기억 단서(두문자·연결 고리)를 준다.\n'
  + "- 학습자가 '백지 인출'·'통째로'를 원하면 범위 전체(예: 문서의 목차와 핵심 내용)를 한 번에 쓰게 하고 같은 방식으로 대조한다.\n"
  + "- '정리'·'그만'·'끝' → 세션 정리: 잘 꺼낸 것·다시 볼 것(구체 항목)·다음에 먼저 볼 것.\n"
  + '- 기록용 태그: 항목의 *최종* 판단이 났을 때만 응답 마지막 줄에 '
  + '[[GRADE id=<약점 id 또는 new> pct=<0~100 재현율> q="항목 요지 20자 이내"]] 를 한 줄로 단다. '
  + '중간 단계·설명·잡담·세션 정리에는 달지 않는다.\n'
);

const ASK_RULES = (
  '\n[자유 학습 — 이 대화의 기본 흐름]\n'
  + '- 학습자가 원하는 대로 유연하게: 설명·요약·비교표·예시·답안 목차 짜기·논점 정리·간단한 퀴즈·암기 확인 등. '
  + "퀴즈를 원하면 아래 [문제 형식]대로, 외운 걸 확인해 달라면 '단서 없이 꺼내게 하고 자료와 대조'하는 방식으로 한다.\n"
  + "- 질문에 바로, 충분히 답하고 끝에 '근거: …' 한 줄 — 실제로 쓴 [자료] 제목만 적고, "
  + "자료 밖 내용을 썼으면 '일반지식'을 함께 적는다(자료를 쓰지 않았는데 자료 제목을 적지 말 것).\n"
  + '- 모호하면 가장 가능성 높은 해석으로 답하고 한 줄로 확인한다.\n'
  + "- 설명이 끝나면 필요할 때 '확인 문제 하나 내 볼까요?'처럼 짧게 제안한다(매번 강요하지 말 것). 학습자가 문제를 내 달라고 하면 퀴즈처럼 진행하고, "
  + '그때도 문항 최종 판단에는 위의 GRADE 태그 형식을 쓸 수 있다: '
  + '[[GRADE id=new pct=<0~100> q="질문 요지"]].\n'
);

/* 음성 대화(Live)에만 붙는 규칙 — 데스크톱 live_voice.VOICE_RULES 와 같다 */
export const VOICE_RULES = (
  '\n[음성 대화 모드 — 지금은 말로 주고받는다]\n'
  + '- 답은 말하듯 짧게: 보통 2~5문장. 학습자가 자세히 원하면 그때 길게.\n'
  + "- 마크다운·표·코드블록·이모지는 쓰지 않는다(소리로 나간다). 목록은 '첫째, 둘째'로 말한다.\n"
  + '- 수식은 말로 읽는다(예: y 는 k 의 알파승). 그래프가 필요하면 말로 축·곡선·이동을 설명한다.\n'
  + '- 판정 태그([[GRADE …]])는 쓰지 않는다 — 음성에선 소리 내어 읽히기 때문이다.\n'
  + '- 자료가 필요한 질문(개념·판례·조문·학설·수치)이면 먼저 search_library 도구로 학습 자료를 찾아 '
  + "그 내용을 근거로 답한다. 찾지 못했으면 '자료에서 확인되지 않는다'고 말하고, 고유 사실은 지어내지 않는다.\n"
  + '- 학습자의 말이 잘 안 들렸거나 애매하면 짧게 되묻는다.\n'
);

export const GRADE_RE = /\[\[GRADE\s+id=([^\s\]]+)\s+pct=(\d{1,3})(?:\s+q="([^"\]]*)")?\s*\]\]/g;
const ASKING = /\?|？|뭐야|뭔가요|무엇|왜|어떻게|설명|차이|예시|예를|알려|정리해|비교|헷갈/;

/* ── 대화 ─────────────────────────────────────────────────────────── */
export function newChat({ mode = 'ask', scope = 'due', subject = '', topic = '', docId = '', docTitle = '' } = {}) {
  const now = Date.now();
  const id = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 7);
  return { id, mode, scope, subject, topic, docId, docTitle, created: now, updated: now, turns: [], graded: [], title: '' };
}

export function scopeLabel(c) {
  if (c.scope === 'doc') return c.docTitle || '문서';
  if (c.scope === 'topic') return c.topic || '주제';
  if (c.scope === 'subject') return c.subject || '과목';
  return '오늘 복습';
}

export function chatTitle(c) {
  if (c.title) return c.title;
  if (c.mode === 'quiz' || c.mode === 'recall') return `${MODES[c.mode]} · ${scopeLabel(c)}`;
  const first = (c.turns.find(t => t.role === 'user') || {}).text || '';
  return first.slice(0, 30) || '새 대화';
}

export function stats(c) {
  const g = c.graded || [];
  return { n: g.length, ok: g.filter(x => x.pct >= 80).length,
           part: g.filter(x => x.pct >= 40 && x.pct < 80).length, miss: g.filter(x => x.pct < 40).length };
}

const CACHE_KEYS = ['material', 'docText', 'topicText', 'topicTitles', 'samplePaths', 'sampleText'];

export async function saveChat(c) {
  c.updated = Date.now();
  const keep = { ...c };
  delete keep.docText; delete keep.topicText; delete keep.sampleText;     // 본문은 다시 받는다
  await idb.put('state', 'tutor.chat.' + c.id, keep);
  const list = (await idb.get('state', 'tutor.list').catch(() => null)) || [];
  const row = { id: c.id, title: chatTitle(c), mode: c.mode, updated: c.updated, stats: stats(c) };
  const next = [row].concat(list.filter(r => r.id !== c.id)).slice(0, 60);
  await idb.put('state', 'tutor.list', next);
  for (const r of list.slice(59)) idb.del('state', 'tutor.chat.' + r.id).catch(() => {});
}

export async function listChats() {
  return (await idb.get('state', 'tutor.list').catch(() => null)) || [];
}
export async function loadChat(id) { return idb.get('state', 'tutor.chat.' + id); }
export async function deleteChat(id) {
  await idb.del('state', 'tutor.chat.' + id).catch(() => {});
  const list = await listChats();
  await idb.put('state', 'tutor.list', list.filter(r => r.id !== id));
}

export function resetScopeCache(c) { for (const k of CACHE_KEYS) delete c[k]; }

/* ── 범위 자료 ────────────────────────────────────────────────────── */
function weakMaterial(subject) {
  try {
    const { items } = review.buildSession({ subject: subject || '', maxItems: 12 });
    return items.map(it => ({ id: 'srs:' + it.id, kind: it.kind || it.type || 'card', subject: it.subject || '',
                              front: String(it.front || '').slice(0, 400), hint: String(it.back || '').slice(0, 600),
                              source: it.source || '' }));
  } catch (e) { return []; }
}

function materialBlock(items) {
  if (!items || !items.length) return '(등록된 약점이 없습니다 — 과목 핵심 개념으로 기초 인출 문제를 내되, id=new 로 판정하세요.)';
  return items.map(it => `- id=${it.id} [${it.subject || '?'}/${it.kind}] ${it.front}\n  (참고: ${it.hint || '-'})`).join('\n');
}

async function docText(file, cap) {
  const d = await docContent.fetchDoc(file);
  // 숨은 HWP 수식 주석(<!--[data-hwpjson]…-->)은 본문이 아니다 — 먼저 걷어 낸다
  return search.htmlToLines(String(d.head || '').replace(/<!--[\s\S]*?-->/g, ' ')).slice(0, cap);
}

function subjectFiles(subject) {
  // 백과 라이브러리의 과목 폴더(국제법 → 국제법학)
  return catalog.files().filter(f => /\.html?$/i.test(f.name || '') && (f.path || '').split('/').some(p => p.startsWith(subject))
    && /encyclopedia\/Library/.test(f.path || ''));
}

async function scopeContext(c, status, cap = DOC_CAP) {
  const ctx = {};
  if (c.scope === 'doc' && c.docId) {
    if (c.docText == null) {
      status?.('문서 읽는 중…');
      const f = catalog.byId(c.docId);
      c.docText = f ? await docText(f, DOC_CAP).catch(() => '') : '';
    }
    ctx.docTitle = c.docTitle; ctx.docText = c.docText.slice(0, cap); ctx.material = [];
  } else if (c.scope === 'topic' && c.topic) {
    if (c.topicText == null) {
      status?.('주제 자료 찾는 중…');
      const r = await search.gather(c.topic, { docs: 4, budget: 3500 }).catch(() => ({ context: '', sources: [] }));
      c.topicText = r.context; c.topicTitles = r.sources.map(s => s.title);
    }
    ctx.topic = c.topic; ctx.topicText = c.topicText.slice(0, cap); ctx.material = [];
  } else {
    if (!c.material) c.material = weakMaterial(c.scope === 'subject' ? c.subject : '');
    ctx.material = c.material;
    if (c.scope === 'subject' && c.subject) {
      if (!c.samplePaths) {
        const pool = subjectFiles(c.subject);
        c.samplePaths = pool.sort(() => Math.random() - 0.5).slice(0, 2).map(f => f.id);
      }
      if (c.sampleText == null) {
        status?.('과목 자료 읽는 중…');
        const parts = [];
        for (const id of c.samplePaths) {
          const f = catalog.byId(id);
          if (!f) continue;
          const t = await docText(f, SAMPLE_CAP).catch(() => '');
          if (t) parts.push(`### ${f.baseTitle || f.name}\n${t}`);
        }
        c.sampleText = parts.join('\n\n');
      }
      ctx.sampleText = c.sampleText.slice(0, cap);
    }
  }
  return ctx;
}

/** 턴마다 줄 [자료]. 자유 학습은 질문마다 검색, 퀴즈·암기 확인은 묻는 말일 때만 검색을 더한다. */
export async function buildContext(c, userText, status) {
  if (c.mode === 'ask') {
    const ctx = (c.scope === 'doc' || c.scope === 'topic') ? await scopeContext(c, status) : {};
    if ((userText || '').trim().length > 1) {
      status?.('관련 자료 찾는 중…');
      const r = await search.gather(userText, { docs: 3, budget: 1800 }).catch(() => ({ context: '' }));
      ctx.searchText = r.context;
    }
    return ctx;
  }
  const ctx = await scopeContext(c, status);
  if (ASKING.test(userText || '') && (userText || '').length > 4) {
    status?.('관련 자료 찾는 중…');
    const r = await search.gather(userText, { docs: 2, budget: 1800 }).catch(() => ({ context: '' }));
    ctx.searchText = r.context;
  }
  return ctx;
}

/** 음성 대화 맥락 — 세션 시작 때 한 번(질문별 검색은 Live 도구가 맡는다). */
export async function voiceContext(c, status) {
  if (c.mode === 'ask') return (c.scope === 'doc' || c.scope === 'topic') ? scopeContext(c, status, VOICE_DOC_CAP) : {};
  return scopeContext(c, status, VOICE_DOC_CAP);
}

export function buildSystem(c, ctx) {
  const mode = c.mode || 'ask';
  const subj = c.subject || '전 과목';
  let s = BASE_RULES + ({ quiz: QUIZ_RULES + QUIZ_FORMATS, recall: RECALL_RULES, ask: ASK_RULES + QUIZ_FORMATS }[mode] || ASK_RULES);
  if (c.scope === 'doc' && ctx.docText) s += `\n[범위] 문서 「${ctx.docTitle || ''}」 — 이 문서 내용에서만 묻고 답한다. 판정 태그의 id 는 new.\n`;
  else if (c.scope === 'topic' && ctx.topic) s += `\n[범위] 주제 「${ctx.topic}」 — 아래 검색된 자료 안에서 묻고 답한다(자료가 빈약하면 그렇다고 말한다). 판정 태그의 id 는 new.\n`;
  else if (mode === 'ask') s += `\n[범위] ${subj}\n`;
  else {
    s += c.scope === 'subject'
      ? `\n[범위] ${subj} — 약점 목록을 먼저, 이어서 아래 과목 문서 표본에서 고루. 학습자가 다른 주제를 말하면 그쪽으로.\n`
      : `\n[범위] ${subj} — 아래 약점 목록 중심(목록이 바닥나면 같은 과목의 연관 개념).\n`;
    s += `\n[약점 목록]\n${materialBlock(ctx.material)}\n`;
  }
  if (mode === 'quiz' || mode === 'recall') {
    const st = stats(c);
    if (st.n) s += `\n[지금까지] ${st.n}문항 · 정확 ${st.ok} · 부분 ${st.part} · 미흡 ${st.miss}\n`;
  }
  if (ctx.docText) s += `\n[자료 — 문서: ${ctx.docTitle || ''}]\n${ctx.docText}\n`;
  if (ctx.topicText) s += `\n[자료 — 주제 「${ctx.topic}」 관련 문서]\n${ctx.topicText}\n`;
  if (ctx.sampleText) s += `\n[자료 — ${subj} 문서 표본(이번 대화에서 고루 다룬다)]\n${ctx.sampleText}\n`;
  if (ctx.searchText) s += `\n[자료 — 검색된 관련 문서]\n${ctx.searchText}\n`;
  return s;
}

/** 한 턴: 사용자 말 → 스트리밍 답 → 판정 반영·저장. 반환 {shown, applied, ctx} */
export async function runTurn(c, userText, { onDelta, status } = {}) {
  const ctx = await buildContext(c, userText, status);
  c.turns.push({ role: 'user', text: userText, ts: Date.now() });
  const turns = c.turns.slice(-HISTORY_TURNS).map(t => ({ role: t.role, text: t.role === 'model' ? t.text.replace(GRADE_RE, '') : t.text }));
  status?.('생각하는 중…');
  let reply;
  try {
    reply = await gemini.stream(turns, { system: buildSystem(c, ctx), onDelta, temperature: 0.5, maxOutputTokens: 6144 });
  } catch (e) {
    c.turns.pop();                     // 실패한 질문은 대화에 남기지 않는다(다시 보낼 수 있게)
    throw e;
  }
  const { shown, applied } = await applyGrades(reply, ctx.material || [], c);
  c.turns.push({ role: 'model', text: reply, ts: Date.now() });
  if (applied.length) c.turns[c.turns.length - 1].note = noteOf(applied);
  await saveChat(c);
  return { shown, applied, ctx };
}

function noteOf(applied) {
  return applied.map(a => a.action === 'graded'
    ? `↻ 복습 일정 반영 — ${a.front.slice(0, 24)}… ${a.pct}%`
    : a.action === 'gap' ? `＋ 복습 카드로(PC) — ${a.front.slice(0, 24)}… (${a.pct}%)` : '').filter(Boolean).join('  ');
}

/** [[GRADE …]] → 기존 카드는 review.grade, 카드 없는 누락(<60)은 PC 로 'tutor.gap'. */
export async function applyGrades(reply, material, c) {
  const applied = [];
  const byId = new Map((material || []).map(m => [m.id, m]));
  for (const m of String(reply || '').matchAll(GRADE_RE)) {
    const gid = m[1], pct = Math.max(0, Math.min(100, Number(m[2]))), q = (m[3] || '').trim();
    const ent = byId.get(gid);
    const front = (ent?.front || q || '').slice(0, 400);
    const res = { id: gid, pct, front: front.slice(0, 60), action: 'none' };
    try {
      if (gid.startsWith('srs:')) {
        const g = pct >= 80 ? 'good' : pct <= 50 ? 'again' : 'hard';      // PC direction_for_pct 와 같은 경계
        const r = await review.grade(gid.slice(4), g, g === 'again' ? (q || '') : '');
        res.action = r ? 'graded' : 'none';
      } else if (pct < 60 && front) {
        const f = c.docId ? catalog.byId(c.docId) : null;
        await outbox.enqueue({ kind: 'tutor.gap', front, hint: ent?.hint || '', pct, subject: ent?.subject || c.subject || '',
                               docPath: f ? `${f.path}/${f.name}` : '', at: Date.now(), name: front.slice(0, 60) });
        res.action = 'gap';
      }
    } catch (e) { log.warn('tutor', '판정 반영 실패', e); }
    applied.push(res);
    (c.graded = c.graded || []).push({ ...res, ts: Date.now() });
  }
  return { shown: String(reply || '').replace(GRADE_RE, '').trimEnd(), applied };
}

/* ── 사실 점검 (데스크톱 review_chat.fact_check 와 같은 기준) ─────────── */
const SPECIFIC_RE = /(?:1[6-9]\d\d|20\d\d)\s*년|\b(?:1[6-9]\d\d|20\d\d)\b|제\s*\d+\s*조|Art(?:icle)?\.?\s*\d+|\d+\s*[:：]\s*\d+|사건|판결|판례|권고적 의견|\bv\.|협약|조약|\d+(?:\.\d+)?\s*%/;
export const needsFactCheck = (reply, minLen = 300) => {
  const t = String(reply || '').replace(GRADE_RE, '');
  return t.length >= minLen && SPECIFIC_RE.test(t);
};

export async function factCheck(reply, ctx) {
  let ref = (ctx?.searchText || ctx?.docText || ctx?.topicText || ctx?.sampleText || '').slice(0, 6000);
  if (!ref && ctx?.material?.length) ref = materialBlock(ctx.material).slice(0, 4000);
  const p = '다음은 외무고시 수험 튜터가 쓴 답변이다. 이 답변에서 *고유 사실*만 골라 Google 검색으로 확인하라 — '
    + '판례·사건명과 그 판시 내용, 판결·체결 연도, 조약명·조문 번호, 표결 수·수치·통계, 학자·저서명, 인용문.\n'
    + '일반적 개념 설명·평가·의견은 제외한다. 최대 8개.\n'
    + '★ 답변 안의 *문제*는 점검하지 않는다 — OX 진술, 객관식 보기, 빈칸 문장, 학습자에게 묻는 질문은 '
    + '튜터의 주장이 아니며 일부러 틀리게 만든 것일 수 있다(점검하면 정답이 미리 드러난다). '
    + '튜터가 정답·해설·설명으로 *단정한* 내용만 점검한다. 문제만 있고 단정이 없으면 claims 는 빈 배열.\n'
    + "verdict: '맞음'(신뢰할 출처로 확인), '틀림'(출처와 다름 — fix 에 바른 내용), "
    + "'불확실'(출처를 찾지 못했거나 출처끼리 다름). 확인 못 한 것을 맞음으로 하지 말 것.\n"
    + 'source: 확인에 쓴 출처 사이트 이름(짧게).\n'
    + '출력은 JSON 하나만: {"claims":[{"claim":"…","verdict":"맞음|틀림|불확실","fix":"…","source":"…"}]}\n\n'
    + (ref ? `[학습 자료 발췌 — 여기서 확인되는 것도 맞음]\n${ref}\n\n` : '')
    + '[튜터 답변]\n' + String(reply || '').replace(GRADE_RE, '');
  const { text, sources } = await gemini.groundedJson(p);
  let data = {};
  try { data = JSON.parse(String(text).replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1')); } catch (e) { data = {}; }
  const claims = (data.claims || []).filter(x => x && x.claim).slice(0, 8);
  return factNote({ claims, sources });
}

function factNote({ claims, sources }) {
  if (!claims.length) return '';
  const bad = claims.filter(x => x.verdict === '틀림');
  const unsure = claims.filter(x => x.verdict === '불확실');
  const ok = claims.length - bad.length - unsure.length;
  if (!bad.length && !unsure.length) return `🔎 사실 점검: 고유 사실 ${ok}건 모두 확인됨${sources.length ? ` (출처: ${sources.join(', ')})` : ''}`;
  const lines = [`🔎 사실 점검: ⚠ 틀림 ${bad.length} · 불확실 ${unsure.length} · 확인 ${ok}`];
  for (const x of bad) lines.push(`✗ ${x.claim} → ${x.fix || '(바른 내용 미상)'}${x.source ? ` [${x.source}]` : ''}`);
  for (const x of unsure) lines.push(`? ${x.claim} — 출처로 확인되지 않음`);
  return lines.join('\n');
}

/** 음성 도구 search_library → 자료 텍스트. */
export async function voiceSearch(query) {
  const r = await search.gather(query, { docs: 3, budget: 2200 }).catch(() => ({ context: '' }));
  return r.context || '';
}
