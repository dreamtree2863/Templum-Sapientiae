/* outbox.js — PC 로 보낼 것을 쌓아 두는 곳.
 *
 *  폰은 언제든 죽고, 지하철에서는 아예 끊긴다. 그래서 "보냈다"가 확인되기 전까지
 *  절대 지우지 않는다. 올린 뒤에만 지운다 → 두 번 보내는 일은 있어도 잃는 일은 없다.
 *
 *  ‼ IndexedDB 에 쌓는다. localStorage 는 학습지 답안이 이미 쓰고 있어(문서 IIFE)
 *    5MB 를 나눠 쓸 수 없다.
 *
 *  ‼ 담는 것은 **상태가 아니라 사건**이다. 같은 사건이 두 번 들어가도 결과가 같도록
 *    id 를 붙인다(시각+무작위, 시간순 정렬 가능). PC 는 본 id 를 기억해 건너뛴다.
 */
import * as idb from '../core/idb.js';
import * as kv from '../core/kv.js';
import { patch } from '../core/store.js';
import * as log from '../core/log.js';

/** 시간순으로 정렬되는 id — 앞 8자리가 시각(36진)이라 문자열 정렬 = 시간 정렬. */
function newId() {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = Math.random().toString(36).slice(2, 10);
  return t + '-' + r;
}

/** 큐에 넣는다. 반환 = 만든 id. */
export async function enqueue(event) {
  const row = { id: newId(), ts: Date.now(), device: kv.deviceId(), tries: 0, ...event };
  await idb.put('outbox', undefined, row);
  await publish();
  log.info('outbox', `${row.kind} 쌓음 (${row.name || row.docId || ''})`);
  return row.id;
}

/** 오래된 것부터. 보내는 순서를 지킨다. */
export function pending() { return idb.outboxByTime(); }

/** 올리기 성공 — 이제야 지운다. */
export async function done(ids) {
  for (const id of ids) await idb.del('outbox', id);
  await publish();
}

/** 실패 기록 — 몇 번 시도했는지는 설정 화면에서 보여 준다. */
export async function failed(id, message) {
  const row = await idb.get('outbox', id);
  if (!row) return;
  row.tries = (row.tries || 0) + 1;
  row.lastError = String(message || '').slice(0, 200);
  await idb.put('outbox', undefined, row);
  await publish();
}

export async function publish() {
  const n = await idb.count('outbox').catch(() => 0);
  patch('outbox', { pending: n });
  return n;
}

export async function clear() {
  await idb.clear('outbox');
  await publish();
}
