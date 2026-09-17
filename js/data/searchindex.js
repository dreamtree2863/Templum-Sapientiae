/* searchindex.js — 본문·소제목·태그까지 보는 검색 색인.
 *
 *  ‼ 원본은 데스크톱 `search_engine.py` 다. 점수 규칙을 **1:1 로** 옮긴다:
 *      태그 5 · 제목 3 · 소제목 2 · 본문 1   (가중치는 PC 가 파일에 실어 보낸다)
 *      키워드 = 공백 분리 + 조사 제거 + 2자 이상 + 불용어 제외
 *      동의어(판례명·학자·약어) 확장
 *    한쪽만 고치면 같은 질문에 폰과 PC 가 다른 답을 준다.
 *
 *  ‼ 색인은 4,196문서 · 약 5MB 다. 한 번 받아 IDB 에 두고 오프라인에서도 쓴다.
 *    (임베딩 43MB·LLM 재정렬은 옮기지 않는다 — 키와 비용이 들고, 키워드 색인만으로도
 *     제목·경로뿐인 지금보다 비교가 안 되게 낫다.)
 */
import * as idb from '../core/idb.js';
import * as log from '../core/log.js';
import * as catalog from './catalog.js';
import { patch } from '../core/store.js';

const INDEX_PATH = '_state/search/index.json';
const SYN_PATH = '_state/search/synonyms.json';

let docs = [];                 // [{t,p,s,g,j,h,x}]
let weights = { tag: 5, title: 3, heading: 2, body: 1 };
let synonyms = new Map();      // term → [동의어…]
let fetchedAt = 0;

let _getToken = () => null;
export function configure({ getToken }) { if (getToken) _getToken = getToken; }

export const ready = () => docs.length > 0;
export const size = () => docs.length;
export const at = () => fetchedAt;

/* ── 받아 오기 ─────────────────────────────────────────────────────── */

function fileAt(path) {
  const i = path.lastIndexOf('/');
  return catalog.files().find(f => f.path === path.slice(0, i) && f.name === path.slice(i + 1)) || null;
}

async function fetchJson(file) {
  const url = 'https://www.googleapis.com/drive/v3/files/'
    + encodeURIComponent(file.id) + '?alt=media';
  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + _getToken() } });
  if (!resp.ok) throw new Error('색인을 받지 못했습니다 (' + resp.status + ')');
  return resp.json();
}

/** Drive 에서 색인을 받아 IDB 에 둔다. 반환 = 문서 수(없으면 null). */
export async function pull({ onProgress } = {}) {
  const f = fileAt(INDEX_PATH);
  if (!f) return null;                       // PC 가 아직 안 내보냈다
  onProgress?.('검색 색인을 받는 중…');
  const d = await fetchJson(f);
  await idb.put('state', 'searchIndex', { ...d, fetchedAt: Date.now() });

  const s = fileAt(SYN_PATH);
  if (s) {
    try { await idb.put('state', 'searchSyn', await fetchJson(s)); } catch (e) { /* 없어도 된다 */ }
  }
  await load();
  log.info('search', `색인 ${docs.length}문서`);
  return docs.length;
}

/** IDB 에 둔 색인을 메모리로. 앱을 켤 때 부른다. */
export async function load() {
  const d = await idb.get('state', 'searchIndex').catch(() => null);
  docs = (d && d.docs) || [];
  if (d && d.weights) weights = d.weights;
  fetchedAt = (d && d.fetchedAt) || 0;

  synonyms = new Map();
  const s = await idb.get('state', 'searchSyn').catch(() => null);
  for (const group of (s && s.groups) || []) {
    const terms = group.map(t => String(t).trim().toLowerCase()).filter(Boolean);
    for (const t of terms) {
      const rest = terms.filter(x => x !== t);
      if (rest.length) synonyms.set(t, (synonyms.get(t) || []).concat(rest));
    }
  }
  patch('search', { indexed: docs.length, at: fetchedAt });
  return docs.length;
}

export async function clear() {
  await idb.del('state', 'searchIndex').catch(() => {});
  await idb.del('state', 'searchSyn').catch(() => {});
  docs = []; fetchedAt = 0;
  patch('search', { indexed: 0, at: 0 });
}

/* ── 키워드 (search_engine.extract_keywords 와 1:1) ─────────────────── */

const PARTICLES = ['으로서', '으로써', '에서는', '에서도', '에서의', '에서',
  '까지', '부터', '처럼', '보다', '마저', '조차', '라는',
  '이라', '라고', '에는', '에도', '에게', '한테',
  '으로', '로서', '로써', '와의', '과의',
  '은', '는', '이', '가', '을', '를', '의', '에', '도',
  '만', '와', '과', '로', '야', '아'];

/* 두루 쓰여 변별력이 없는 말 — 점수에 잡음만 키운다(분야 고유어는 절대 넣지 않는다). */
const STOPWORDS = new Set([
  '분석', '이슈', '개념', '정의', '설명', '내용', '방법', '의미', '특징',
  '종류', '유형', '관련', '경우', '사용', '적용', '정리', '요약', '비교',
  '구분', '중요', '핵심', '기본', '문제', '관점', '측면', '부분', '전체',
  '사례', '예시', '정도', '자체', '기준', '대상', '다음', '위주', '중심',
  '어떻게', '무엇', '무엇인가', '무엇인지', '어떤', '어떠한', '왜', '어디',
  '언제', '누구', '얼마', '그리고', '하지만', '그러나', '또한', '따라서',
  '대해', '대하여', '관하여', '알려줘', '알려', '설명해', '정리해', '해줘',
]);

export function keywords(query) {
  const out = [];
  for (const raw of String(query || '').split(/[\s,.?!;:()/\[\]{}"'`~·]+/)) {
    let t = raw.trim().toLowerCase();
    if (!t || t.length < 2) continue;
    for (const p of PARTICLES) {
      if (t.endsWith(p) && t.length > p.length + 1) { t = t.slice(0, -p.length); break; }
    }
    if (t.length < 2 || STOPWORDS.has(t) || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}

/** 동의어를 더한다 — 표기 하나만 알아도 나머지가 걸리도록. */
export function expand(kws, max = 16) {
  const out = kws.slice();
  for (const k of kws) {
    for (const alt of synonyms.get(k) || []) {
      if (out.length >= kws.length + max) break;
      if (!out.includes(alt)) out.push(alt);
    }
  }
  return out;
}

/* ── 점수 (search_engine._score_entry 와 1:1) ───────────────────────── */

function count(hay, needle) {
  if (!hay || !needle) return 0;
  let n = 0, i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j < 0) return n;
    n++; i = j + needle.length;
  }
}

function scoreOf(e, kws) {
  const title = (e.t || '').toLowerCase();
  const head = (e.h || '').toLowerCase();
  const body = (e.x || '').toLowerCase();
  const tags = (e.g || []).join(' ').toLowerCase();
  let s = 0;
  for (const k of kws) {
    if (tags) s += count(tags, k) * weights.tag;
    s += count(title, k) * weights.title;
    s += count(head, k) * weights.heading;
    s += count(body, k) * weights.body;
  }
  return s;
}

/** 어디에서 맞았는지 — 결과에 근거를 보여 준다. */
function where(e, kws) {
  const has = (s) => s && kws.some(k => s.includes(k));
  const hit = [];
  if (has((e.g || []).join(' ').toLowerCase())) hit.push('태그');
  if (has((e.t || '').toLowerCase())) hit.push('제목');
  if (has((e.h || '').toLowerCase())) hit.push('소제목');
  if (has((e.x || '').toLowerCase())) hit.push('본문');
  return hit;
}

/** 본문에서 키워드가 처음 나오는 대목을 잘라 미리보기로. */
function snippet(e, kws, width = 150) {
  const body = e.x || '';
  if (!body) return '';
  const low = body.toLowerCase();
  let pos = -1;
  for (const k of kws) {
    const i = low.indexOf(k);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) return body.slice(0, width).trim();
  const start = Math.max(0, pos - Math.floor(width / 3));
  const text = body.slice(start, start + width).trim();
  return (start > 0 ? '…' : '') + text + (start + width < body.length ? '…' : '');
}

/**
 * 색인 검색. 반환 [{path, title, source, subject, score, where[], snippet, tags}]
 * 색인이 없으면 빈 배열 — 호출부가 제목·경로 검색으로 돌아간다.
 */
export function search(query, { limit = 30, source = '' } = {}) {
  if (!docs.length) return [];
  const kws = expand(keywords(query));
  if (!kws.length) return [];
  const out = [];
  for (const e of docs) {
    if (source && e.s !== source) continue;
    const s = scoreOf(e, kws);
    if (s <= 0) continue;
    out.push({
      path: e.p, title: e.t, source: e.s, subject: (e.j || []).join(' › '),
      tags: e.g || [], score: s, where: where(e, kws), snippet: snippet(e, kws),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/** 색인 항목의 경로 → 카탈로그의 실제 파일(열려면 id 가 필요하다). */
export function fileOf(indexPath) {
  const name = String(indexPath || '').replace(/\\/g, '/').split('/').pop();
  if (!name) return null;
  const all = catalog.files();
  return all.find(f => f.name === name) || null;
}
