/* mcq.js — 객관식. PC 가 내보낸 문제은행을 세트 단위로 받아 푼다.
 *
 *    PC → Templum/_state/mcq/index.json      세트 목록(가벼움)
 *         Templum/_state/mcq/<세트>.json     고른 세트만
 *         Templum/_state/mcq.json            오답노트
 *    폰 → _inbox/<기기>/*.jsonl              응시 결과를 사건으로
 *
 *  ‼ 은행 전체는 24MB 다(자료해석만 18MB — 표·그림이 본문에 박혀 있다).
 *    통째로 받지 않는다. 목록을 먼저 보고, 고른 세트 하나만 받는다.
 *
 *  ‼ 받은 세트는 IDB 에 둔다 — 지하철에서 다시 풀 수 있어야 한다.
 */
import * as idb from '../core/idb.js';
import * as log from '../core/log.js';
import * as outbox from './outbox.js';
import * as catalog from './catalog.js';

const INDEX_PATH = '_state/mcq/index.json';
const WRONG_PATH = '_state/mcq.json';

let _getToken = () => null;
export function configure({ getToken }) { if (getToken) _getToken = getToken; }

function fileAt(path) {
  const i = path.lastIndexOf('/');
  const dir = path.slice(0, i);
  const name = path.slice(i + 1);
  return catalog.files().find(f => f.path === dir && f.name === name) || null;
}

async function fetchJson(file) {
  const url = 'https://www.googleapis.com/drive/v3/files/'
    + encodeURIComponent(file.id) + '?alt=media';
  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + _getToken() } });
  if (!resp.ok) throw new Error('받지 못했습니다 (' + resp.status + ')');
  return resp.json();
}

/* ── 세트 목록 ────────────────────────────────────────────────────── */

export async function pullIndex() {
  const f = fileAt(INDEX_PATH);
  if (!f) return null;                       // PC 가 아직 안 내보냈다
  const d = await fetchJson(f);
  await idb.put('state', 'mcqIndex', { ...d, fetchedAt: Date.now() });
  log.info('mcq', `세트 ${(d.sets || []).length}개`);
  return d.sets || [];
}

export async function sets() {
  const d = await idb.get('state', 'mcqIndex').catch(() => null);
  return (d && d.sets) || [];
}

/* ── 세트 하나 ────────────────────────────────────────────────────── */

export async function loadSet(fileName, { force = false } = {}) {
  const key = 'mcqSet:' + fileName;
  if (!force) {
    const cached = await idb.get('state', key).catch(() => null);
    if (cached) return cached;
  }
  const f = fileAt('_state/mcq/' + fileName);
  if (!f) throw new Error('이 세트를 Drive 에서 찾지 못했습니다.');
  const d = await fetchJson(f);
  await idb.put('state', key, d).catch(() => {});
  return d;
}

export async function cachedSets() {
  const all = await sets();
  const out = [];
  for (const s of all) {
    const hit = await idb.get('state', 'mcqSet:' + s.file).catch(() => null);
    if (hit) out.push(s);
  }
  return out;
}

/* ── 시험 ─────────────────────────────────────────────────────────── */

/** 문항을 섞는다. 같은 세트를 두 번 풀 때 순서를 외우는 것을 막는다. */
export function shuffle(list, seed = Date.now()) {
  const a = list.slice();
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 고른 답이 맞는가. 정답은 '④' 같은 동그라미 숫자이거나 '4' 일 수 있다. */
export function isCorrect(q, chosenLabel) {
  const norm = (s) => String(s || '').trim()
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, (c) => String('①②③④⑤⑥⑦⑧⑨⑩'.indexOf(c) + 1));
  return norm(chosenLabel) === norm(q.answer);
}

/**
 * 채점 결과를 남긴다 — 이 기기에 기록하고 PC 로 보낸다.
 *   answers: [{num, chosen, correct}]
 */
export async function submit({ subject, set, file, answers, elapsed }) {
  const right = answers.filter(a => a.correct).length;
  const attempt = {
    kind: 'mcq.attempt', subject, set, file,
    at: Date.now(), elapsed: elapsed || 0,
    total: answers.length, right,
    wrong: answers.filter(a => !a.correct).map(a => ({ num: a.num, chosen: a.chosen })),
  };
  const hist = (await idb.get('state', 'mcqHistory').catch(() => null)) || [];
  hist.unshift({ subject, set, at: attempt.at, total: attempt.total, right });
  await idb.put('state', 'mcqHistory', hist.slice(0, 100)).catch(() => {});
  await outbox.enqueue(attempt);
  return attempt;
}

export async function history(n = 20) {
  const h = (await idb.get('state', 'mcqHistory').catch(() => null)) || [];
  return h.slice(0, n);
}

/* ── 오답노트 ─────────────────────────────────────────────────────── */

export async function pullWrong() {
  const f = fileAt(WRONG_PATH);
  if (!f) return null;
  const d = await fetchJson(f);
  await idb.put('state', 'mcqWrong', { ...d, fetchedAt: Date.now() });
  return (d.wrong || []).length;
}

/** PC 오답노트 + 이 기기에서 틀린 것을 합쳐 돌려준다. */
export async function wrongPool() {
  const pc = (await idb.get('state', 'mcqWrong').catch(() => null)) || {};
  const local = (await idb.get('state', 'mcqWrongLocal').catch(() => null)) || [];
  return { pc: pc.wrong || [], local };
}

/** 이 기기에서 틀린 문항을 쌓아 둔다 — 오답 재시험용. */
export async function rememberWrong(subject, set, file, items) {
  if (!items.length) return 0;
  const local = (await idb.get('state', 'mcqWrongLocal').catch(() => null)) || [];
  const key = (x) => `${x.subject}|${x.set}|${x.num}`;
  const map = new Map(local.map(x => [key(x), x]));
  for (const it of items) {
    const row = { subject, set, file, num: it.num, at: Date.now(), q: it.q };
    map.set(key(row), row);
  }
  const next = Array.from(map.values()).slice(-300);
  await idb.put('state', 'mcqWrongLocal', next).catch(() => {});
  return next.length;
}

/** 맞히면 오답노트에서 뺀다 — 데스크톱 mcq_store 와 같은 규칙. */
export async function clearWrong(subject, set, nums) {
  const local = (await idb.get('state', 'mcqWrongLocal').catch(() => null)) || [];
  const gone = new Set(nums.map(String));
  const next = local.filter(x => !(x.subject === subject && x.set === set && gone.has(String(x.num))));
  await idb.put('state', 'mcqWrongLocal', next).catch(() => {});
  return local.length - next.length;
}
