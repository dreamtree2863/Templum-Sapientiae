/* review.js — 복습(간격반복). PC 가 내보낸 카드를 읽고, 채점은 큐로 돌려보낸다.
 *
 *    PC → Templum/_state/review.json   (읽기만)
 *    폰 → _inbox/<기기>/*.jsonl        (채점을 사건으로)
 *
 *  ‼ 주기 수학은 **데스크톱 `core/review_engine.py` 와 1:1** 이어야 한다.
 *    한쪽만 고치면 같은 카드가 폰과 PC 에서 다른 날 뜬다.
 *      advance()            ↔ review_engine.advance (:133)
 *      directionForGrade()  ↔ review_engine.direction_for_grade (:148)
 *      buildSession()       ↔ review_engine.build_session (:433)
 *    간격표는 PC 가 내보낸 파일에 실려 오므로(intervals) 상수를 두 곳에 두지 않는다.
 *
 *  ‼ 폰에서 매긴 채점은 **즉시 화면에 반영**하고(오프라인에서도 진도가 나가야 한다)
 *    동시에 outbox 에 쌓아 PC 로 보낸다. 충돌은 PC 가 3단 규칙으로 정리한다.
 */
import * as idb from '../core/idb.js';
import * as log from '../core/log.js';
import { patch } from '../core/store.js';
import * as outbox from './outbox.js';
import * as catalog from './catalog.js';

const STATE_PATH = '_state/review.json';
const DAY = 86400;
let cards = [];                       // 화면이 쓰는 사본(폰에서 매긴 채점이 이미 반영됨)
let intervals = [1, 3, 7, 21, 60];    // PC 가 보내 주면 덮어쓴다

let _getToken = () => null;
export function configure({ getToken }) { if (getToken) _getToken = getToken; }

/* ── 받아 오기 ─────────────────────────────────────────────────────── */

/** Drive 의 `_state/review.json` 을 받아 IDB 에 둔다. 없으면 조용히 넘어간다. */
export async function pull() {
  const file = catalog.files().find(f => (f.path + '/' + f.name) === STATE_PATH);
  if (!file) { log.info('review', 'PC 가 아직 복습 상태를 내보내지 않았습니다'); return null; }
  const url = 'https://www.googleapis.com/drive/v3/files/'
    + encodeURIComponent(file.id) + '?alt=media';
  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + _getToken() } });
  if (!resp.ok) throw new Error('복습 카드를 받지 못했습니다 (' + resp.status + ')');
  const d = await resp.json();
  await idb.put('state', 'review', { ...d, fetchedAt: Date.now() });
  await load();
  log.info('review', `카드 ${cards.length}장 받음`);
  return cards.length;
}

/** IDB 에 둔 사본을 메모리로. 앱을 켤 때 부른다(오프라인에서도 복습이 된다). */
export async function load() {
  const d = await idb.get('state', 'review').catch(() => null);
  if (!d) { cards = []; publish(); return 0; }
  if (Array.isArray(d.intervals) && d.intervals.length) intervals = d.intervals;
  cards = (d.items || []).map(c => ({ ...c }));
  // 폰에서 매긴 채점을 덮어씌운다 — 아직 PC 로 못 보낸 것도 화면엔 반영돼야 한다
  const local = (await idb.get('state', 'reviewLocal').catch(() => null)) || {};
  for (const c of cards) {
    const l = local[c.id];
    if (l && (l.last_reviewed || 0) > (c.last_reviewed || 0)) Object.assign(c, l);
  }
  publish();
  return cards.length;
}

function publish() {
  patch('review', { total: cards.length, due: dueNow().length });
}

/* ── 주기 수학 (PC 와 1:1) ──────────────────────────────────────────── */

/** review_engine.advance — 반환 {level, lapses, days} */
export function advance(level, lapses, direction) {
  let lvl = Number(level) || 0;
  let lap = Number(lapses) || 0;
  if (direction === 'up') lvl = Math.min(lvl + 1, intervals.length - 1);
  else if (direction === 'reset') { lap += 1; lvl = 0; }
  lvl = Math.min(Math.max(lvl, 0), intervals.length - 1);
  return { level: lvl, lapses: lap, days: intervals[lvl] };
}

/** review_engine.direction_for_grade */
export function directionForGrade(grade) {
  if (grade === 'good') return 'up';
  if (grade === 'again') return 'reset';
  return 'hold';
}

/* ── 오늘 볼 것 ────────────────────────────────────────────────────── */

export function all() { return cards; }

export function dueNow(at = Date.now()) {
  const now = Math.floor(at / 1000);
  return cards.filter(c => !c.pending && Number(c.due || 0) <= now);
}

const kindOf = (c) => c.kind || c.type || '';

/**
 * review_engine.build_session 과 같은 규칙:
 *   불안정(level 낮은) 먼저 → 배점 큰 것 → 자주 틀린 것 → 오래된 것
 *   같은 종류 3장 연속을 피한다 — 머리가 한 패턴에 굳는 것을 막는다
 *   하루 상한을 넘는 것은 다음 날로 이월(due 는 건드리지 않는다)
 */
export function buildSession({ subject = '', maxItems = 20 } = {}) {
  const pool = dueNow().filter(c => !subject || c.subject === subject);
  const total = pool.length;
  pool.sort((a, b) =>
    (Number(a.level || 0) - Number(b.level || 0))
    || (Number(b.points || 0) - Number(a.points || 0))
    || (Number(b.lapses || 0) - Number(a.lapses || 0))
    || (Number(a.due || 0) - Number(b.due || 0)));

  const picked = [];
  const rest = pool.slice();
  while (rest.length && picked.length < maxItems) {
    let i = 0;
    if (picked.length >= 2 && kindOf(picked[picked.length - 1]) === kindOf(picked[picked.length - 2])) {
      const alt = rest.findIndex(c => kindOf(c) !== kindOf(picked[picked.length - 1]));
      if (alt >= 0) i = alt;
    }
    picked.push(rest.splice(i, 1)[0]);
  }
  return { items: picked, totalDue: total, carried: Math.max(0, total - picked.length) };
}

/* ── 채점 ─────────────────────────────────────────────────────────── */

/**
 * 카드 한 장을 채점한다. 화면에는 즉시, PC 로는 큐를 통해.
 * 반환 {days} — "며칠 뒤에 다시"를 바로 보여 주려고.
 */
export async function grade(cardId, gradeName, weakNote = '') {
  const c = cards.find(x => x.id === cardId);
  if (!c) return null;
  const at = Date.now();
  const ts = Math.floor(at / 1000);
  const r = advance(c.level, c.lapses, directionForGrade(gradeName));

  c.level = r.level;
  c.lapses = r.lapses;
  c.due = ts + r.days * DAY;
  c.last_reviewed = ts;
  c.total_reviews = Number(c.total_reviews || 0) + 1;
  if (gradeName === 'again') {
    c.total_fails = Number(c.total_fails || 0) + 1;
    const note = (weakNote || '').trim();
    if (note) c.weak_points = (c.weak_points || []).concat([note]).slice(-3);
  }

  // 아직 못 보낸 채점도 화면엔 남아야 한다(비행기 모드에서 푼 것)
  const local = (await idb.get('state', 'reviewLocal').catch(() => null)) || {};
  local[c.id] = {
    level: c.level, lapses: c.lapses, due: c.due, last_reviewed: c.last_reviewed,
    total_reviews: c.total_reviews, total_fails: c.total_fails, weak_points: c.weak_points,
  };
  await idb.put('state', 'reviewLocal', local).catch(() => {});

  await outbox.enqueue({
    kind: 'review.grade', itemId: c.id, grade: gradeName, at,
    weakNote: weakNote || '', name: c.front ? String(c.front).slice(0, 60) : '',
  });
  publish();
  return { days: r.days, level: r.level };
}

/** 오래된 로컬 기록 청소 — PC 가 이미 반영한 것은 들고 있을 필요가 없다. */
export async function pruneLocal() {
  const local = (await idb.get('state', 'reviewLocal').catch(() => null)) || {};
  let n = 0;
  for (const [id, l] of Object.entries(local)) {
    const c = cards.find(x => x.id === id);
    if (c && (c.last_reviewed || 0) >= (l.last_reviewed || 0) && !isLocalNewer(c, l)) {
      delete local[id]; n++;
    }
  }
  if (n) await idb.put('state', 'reviewLocal', local).catch(() => {});
  return n;
}

function isLocalNewer(c, l) {
  return (l.last_reviewed || 0) > (c.last_reviewed || 0);
}
