/* search.js — 자료에서 찾고, (원하면) 그 자료에 근거해 답을 받는다.
 *
 *  ‼ 두 층으로 나눈 이유가 있다.
 *      ① 랭킹 검색   — 목록만 보고 고른다. 내려받지 않으니 **오프라인에서도** 즉시.
 *      ② 근거 추리기 — 고른 문서 몇 편만 받아 질문과 관련된 단락만 뽑는다.
 *      ③ AI 답변     — ②의 근거만 물려 준다. 키가 없으면 ①②까지만 쓴다.
 *    ①이 혼자서도 쓸모 있어야 한다. 키가 없다고 검색이 막히면 안 된다.
 *
 *  ‼ 점수 규칙은 옛 app.js(1469-1620)를 그대로 옮겼다 — 제목 일치 +3, 경로 +1,
 *    결과가 빈약하면 글자 바이그램 겹침으로 보강. 한국어에서 이게 형태소 분석 없이도
 *    꽤 맞는다.
 */
import * as catalog from './catalog.js';
import * as index from './searchindex.js';
import * as classify from './classify.js';
import * as docContent from './doc-content.js';
import * as kv from '../core/kv.js';
import * as log from '../core/log.js';

const KEY_LS = 'ai.key';
const MODEL_LS = 'ai.model';
const DEFAULT_MODEL = 'gemini-2.5-flash';

export const hasKey = () => !!kv.get(KEY_LS);
export const getModel = () => kv.get(MODEL_LS) || DEFAULT_MODEL;
export function setKey(k) { if (k) kv.set(KEY_LS, String(k).trim()); else kv.del(KEY_LS); }
export function setModel(m) { if (m) kv.set(MODEL_LS, String(m).trim()); else kv.del(MODEL_LS); }

/* ── ① 랭킹 검색 ──────────────────────────────────────────────────── */

/* ‼ 한국어는 조사가 붙어 온다 — "비교우위**란**", "무역**에서**".
 *   그대로 찾으면 제목의 "비교우위" 와 안 맞아 결과가 0 이 된다(실제로 겪었다).
 *   형태소 분석기를 싣지 않고, 흔한 조사만 떼어 본다. 떼어 낸 꼴은 조금 낮게 친다. */
const JOSA = ['이란', '라는', '에서', '으로', '에게', '까지', '부터', '보다', '처럼',
  '한테', '에는', '와의', '과의', '의', '은', '는', '이', '가', '을', '를', '에', '도',
  '만', '과', '와', '란', '로'];

function stripJosa(t) {
  for (const j of JOSA) {
    if (t.length >= j.length + 2 && t.endsWith(j)) return t.slice(0, -j.length);
  }
  return t;
}

/** 질문 → 찾을 낱말들. [{t, w}] — w 는 가중치(원형 1, 조사 뗀 꼴 0.7). */
export function tokenize(q) {
  const raw = String(q || '').toLowerCase()
    .split(/[\s,.?!()\[\]{}'"·…:;/\\、，。]+/)
    .filter(t => t.length >= 2);
  const out = [];
  const seen = new Set();
  for (const t of raw) {
    if (!seen.has(t)) { seen.add(t); out.push({ t, w: 1 }); }
    const s = stripJosa(t);
    if (s !== t && s.length >= 2 && !seen.has(s)) { seen.add(s); out.push({ t: s, w: 0.7 }); }
  }
  return out;
}

/** 단순 문자열 목록이 필요할 때(단락 점수 등). */
export const words = (q) => tokenize(q).map(x => x.t);

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/**
 * 질문에 맞는 문서 상위 n편.
 *
 * ‼ 색인(본문·소제목·태그)이 있으면 그것을 쓴다 — 데스크톱과 같은 규칙이라 같은 답이
 *   나온다. 없으면 제목·경로만 보는 예전 방식으로 돌아간다(색인을 안 받았어도 쓸 수 있게).
 */
export function rank(query, { limit = 12, root = '' } = {}) {
  if (index.ready()) {
    const hits = index.search(query, { limit: limit * 2 });
    const out = [];
    for (const h of hits) {
      const f = index.fileOf(h.path);
      if (!f) continue;                       // 목록에 없는 문서(지워졌거나 미동기화)
      if (root && !(f.path || '').startsWith(root)) continue;
      const info = classify.classify(f);
      out.push({ ...f, ...info, score: h.score, weak: false,
                 where: h.where, snippet: h.snippet, tags: h.tags });
      if (out.length >= limit) break;
    }
    if (out.length) return out;
    // 색인이 아무것도 못 찾았으면 제목·경로로 한 번 더 — 빈손으로 돌려보내지 않는다
  }
  return rankByName(query, { limit, root });
}

/** 제목·경로만 보는 옛 방식 — 색인이 없거나 색인이 못 찾았을 때. */
function rankByName(query, { limit = 12, root = '' } = {}) {
  const tokens = tokenize(query);
  const pool = catalog.files().filter(f =>
    !classify.isAudio(f.name) && !classify.isSystemPath(f.path)
    && (!root || (f.path || '').startsWith(root)));

  const scored = pool.map(f => {
    const info = classify.classify(f);
    const title = (info.baseTitle || f.name).toLowerCase();
    const path = (f.path || '').toLowerCase();
    let s = 0;
    for (const { t, w } of tokens) {
      if (title.includes(t)) s += 3 * w;
      if (path.includes(t)) s += 1 * w;
    }
    return { f, info, s };
  });

  let hit = scored.filter(x => x.s > 0).map(x => ({ ...x, weak: false }));

  if (hit.length < 5 && tokens.length) {
    /* 글자가 조금씩 다를 때(띄어쓰기·표기 차이) 바이그램 겹침으로 건진다.
       ‼ 문턱을 낮게 두면 **아무 관계 없는 질문에도 뭔가를 내놓는다**
         ("양자역학"에 5편이 나왔다). 그게 AI 근거로 들어가면 엉뚱한 자료로
         자신 있게 답하게 된다 — 이 화면에서 가장 나쁜 일이다.
         그래서 겹침을 넉넉히 요구하고, 건진 것은 weak 로 표시해 구분한다. */
    const qb = bigrams(String(query).toLowerCase().replace(/\s+/g, ''));
    const extra = scored.filter(x => !x.s).map(x => {
      const tb = bigrams((x.info.baseTitle || x.f.name).toLowerCase().replace(/\s+/g, ''));
      let over = 0;
      for (const g of qb) if (tb.has(g)) over++;
      return { ...x, over, ratio: over / Math.max(4, qb.size) };
    }).filter(x => x.over >= 3 && x.ratio >= 0.34)
      .map(x => ({ ...x, s: 0.5 + x.ratio, weak: true }));
    hit = hit.concat(extra);
  }
  hit.sort((a, b) => (b.s - a.s) || ((b.f.mtime || 0) - (a.f.mtime || 0)));
  return hit.slice(0, limit).map(x => ({
    ...x.f, ...x.info, score: Number(x.s.toFixed(2)), weak: !!x.weak,
  }));
}

/* ── ② 근거 추리기 ────────────────────────────────────────────────── */

function lineScore(line, tokens) {
  const l = line.toLowerCase();
  let s = 0;
  for (const t of tokens) {
    const w = typeof t === 'string' ? t : t.t;
    const weight = typeof t === 'string' ? 1 : t.w;
    const c = l.split(w).length - 1;
    if (c > 0) s += (2 + Math.min(2, c - 1)) * weight;
  }
  return s;
}

/**
 * 본문에서 **질문과 관련된 단락만** 예산 안에서 추린다.
 * ‼ 앞부분을 통째로 넣지 않는다 — 문서 앞머리는 대개 목차라 답이 없다.
 */
export function extractPassages(text, tokens, budget = 1800) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(l => l.length > 1);
  if (!lines.length) return String(text || '').slice(0, budget);
  const hits = lines.map((l, i) => ({ i, s: lineScore(l, tokens) }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  if (!hits.length) return lines.join('\n').slice(0, budget);

  const picked = new Map();
  let used = 0;
  for (const h of hits) {
    for (let j = Math.max(0, h.i - 1); j <= Math.min(lines.length - 1, h.i + 1); j++) {
      if (picked.has(j)) continue;
      if (used + lines[j].length > budget && picked.size) continue;
      picked.set(j, lines[j]);
      used += lines[j].length;
    }
    if (used >= budget) break;
  }
  const idx = [...picked.keys()].sort((a, b) => a - b);
  let out = '', prev = -2;
  for (const j of idx) {
    out += (j === prev + 1 ? '\n' : (out ? '\n…\n' : '')) + lines[j];
    prev = j;
  }
  return out.length > budget ? out.slice(0, budget) + ' …' : out;
}

/** HTML → 읽을 수 있는 줄들. 스크립트·스타일은 버린다. */
export function htmlToLines(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(s => s.trim()).filter(Boolean)
    .join('\n');
}

/**
 * 상위 문서 몇 편을 받아 근거를 만든다. 반환 {context, sources}
 * ‼ 폰 데이터가 든다 — 기본 3편, 각 1,800자까지만.
 */
export async function gather(query, { docs = 3, budget = 1800, onProgress } = {}) {
  const tokens = tokenize(query);
  /* ‼ 이름만 어렴풋이 닮은 것(weak)은 근거로 쓰지 않는다.
     엉뚱한 자료를 물려 주면 AI 가 그걸 근거로 그럴듯한 오답을 만든다. */
  const top = rank(query, { limit: docs * 2 }).filter(f => !f.weak).slice(0, docs);
  const parts = [];
  const sources = [];
  for (let i = 0; i < top.length; i++) {
    const f = top[i];
    onProgress?.(i + 1, top.length, f.baseTitle || f.name);
    try {
      const d = await docContent.fetchDoc(f);
      const text = htmlToLines(d.head);
      const passage = extractPassages(text, tokens, budget);
      if (!passage.trim()) continue;
      parts.push(`[출처: ${f.baseTitle || f.name} · ${f.path}]\n${passage}`);
      sources.push({ id: f.id, title: f.baseTitle || f.name, path: f.path });
    } catch (e) {
      log.warn('search', `${f.name} 를 읽지 못했습니다`, e);
    }
  }
  return { context: parts.join('\n\n'), sources };
}

/* ── ③ AI 답변 (선택) ─────────────────────────────────────────────── */

function prompt(query, context) {
  return '당신은 통합 학습 도우미입니다. 아래 자료에만 근거하여 한국어로 답변하세요.\n'
    + '각 자료 머리의 [출처: …] 표기를 활용해 답변 끝에 사용한 문서를 적으세요.\n'
    + "자료에 없는 내용은 추측하지 말고 '자료에서 찾을 수 없습니다.' 라고 답하세요.\n"
    + '수식은 \\( … \\) 또는 \\[ … \\] 로 쓰세요.\n\n'
    + '=== 자료 ===\n' + context + '\n===========\n\n=== 질문 ===\n' + query;
}

/** 근거를 물려 답을 받는다. 키가 없으면 그 사실을 알린다. */
export async function ask(query, context) {
  const key = kv.get(KEY_LS);
  if (!key) { const e = new Error('AI 키가 없습니다'); e.needKey = true; throw e; }
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + encodeURIComponent(getModel()) + ':generateContent?key=' + encodeURIComponent(key);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt(query, context) }] }] }),
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json())?.error?.message || ''; } catch (e) { /* 본문 없음 */ }
    throw new Error(`AI 응답 실패 (${resp.status})${detail ? ' — ' + detail : ''}`);
  }
  const d = await resp.json();
  const text = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!text) throw new Error('AI 가 빈 답을 보냈습니다');
  return text;
}
