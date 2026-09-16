/* uplink.js — 쌓아 둔 것을 PC 로 보낸다.
 *
 *  보내는 곳:  Templum/_inbox/<기기>/<시각>.jsonl   (한 줄 = 사건 하나)
 *  PC 쪽 짝:   core/mobile_sync.run_pull — 읽고 `_inbox/.done` 으로 옮긴다.
 *
 *  ‼ 올린 **뒤에만** 큐에서 지운다. 두 번 보내는 일은 있어도 잃는 일은 없다.
 *    사건마다 시간순 id 가 있어 PC 가 중복을 건너뛴다(멱등).
 *
 *  ‼ `_inbox` 는 Templum 루트 바로 아래다. drive_sync 의 정리(`_prune_orphans`)는
 *    archive 가지만 돌고 `.html` 만 지우므로 여기엔 닿지 않는다.
 */
import * as files from './drive-files.js';
import * as outbox from './outbox.js';
import * as auth from './auth.js';
import * as catalog from './catalog.js';
import * as kv from '../core/kv.js';
import * as log from '../core/log.js';
import { patch } from '../core/store.js';

const INBOX = '_inbox';
let busy = false;

/** 기기 폴더 id 를 만들어 둔다(한 번 만들면 앱이 계속 쓸 수 있다). */
async function deviceFolder() {
  const root = catalog.templumId();
  if (!root) throw new Error('Drive 에서 Templum 폴더를 찾지 못했습니다.');
  const inbox = await files.ensureFolder(INBOX, root);
  return files.ensureFolder(kv.deviceId(), inbox);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 큐를 비운다. 반환 {sent, kept, skipped?, error?}
 *
 * 한 번에 한 파일로 묶어 올린다 — 사건 수만큼 요청하면 폰 배터리·데이터가 아깝다.
 */
export async function flush({ silent = true } = {}) {
  if (busy) return { skipped: 'busy' };
  if (!navigator.onLine) return { skipped: 'offline' };
  if (!auth.signedIn()) return { skipped: 'signed-out' };
  if (!auth.hasScope(auth.SCOPE_WRITE)) return { skipped: 'no-write-scope' };

  const rows = await outbox.pending();
  if (!rows.length) return { sent: 0, kept: 0 };

  busy = true;
  patch('outbox', { sending: true });
  try {
    const folder = await deviceFolder();
    const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
    await files.uploadText(folder, `${stamp()}.jsonl`, text);
    await outbox.done(rows.map(r => r.id));      // ‼ 올린 뒤에야 지운다
    log.info('uplink', `${rows.length}건 보냄`);
    return { sent: rows.length, kept: 0 };
  } catch (e) {
    log.warn('uplink', '보내기 실패 — 큐에 그대로 둔다', e);
    for (const r of rows.slice(0, 1)) await outbox.failed(r.id, e.message);
    if (!silent) throw e;
    return { sent: 0, kept: rows.length, error: e.message };
  } finally {
    busy = false;
    patch('outbox', { sending: false });
  }
}

/**
 * 연결 시험 — 권한이 실제로 통하는지 한 번에 확인한다.
 *
 * ‼ 이것이 4단계의 스파이크다. `drive.file` 권한으로 **앱이 만들지 않은 폴더**
 *   (Templum) 안에 `_inbox` 를 만들 수 있는가. 문서로는 단정할 수 없어 직접 해 본다.
 *   막히면 더 넓은 권한으로 갈아타야 한다는 뜻이고, 그 사실이 여기서 드러난다.
 *
 * 만든 시험 파일은 바로 지운다.
 */
export async function probe() {
  const steps = [];
  const step = (name, ok, detail) => { steps.push({ name, ok, detail: detail || '' }); return ok; };

  if (!navigator.onLine) return { ok: false, steps: [{ name: '연결', ok: false, detail: '오프라인' }] };
  if (!auth.signedIn()) return { ok: false, steps: [{ name: '로그인', ok: false, detail: '로그인이 필요합니다' }] };
  step('로그인', true);

  if (!auth.hasScope(auth.SCOPE_WRITE)) {
    return { ok: false, needScope: true,
             steps: steps.concat([{ name: '쓰기 권한', ok: false, detail: '아직 동의하지 않았습니다' }]) };
  }
  step('쓰기 권한', true);

  const root = catalog.templumId();
  if (!step('Templum 폴더', !!root, root ? '' : '목록을 먼저 새로고침해 주세요')) {
    return { ok: false, steps };
  }

  let inbox;
  try {
    inbox = await files.ensureFolder(INBOX, root);
    step('_inbox 폴더', true, '만들거나 찾았습니다');
  } catch (e) {
    // ★ 여기서 막히면 `drive.file` 로는 남의 폴더에 못 쓴다는 뜻이다
    step('_inbox 폴더', false, e.message);
    return { ok: false, steps, scopeTooNarrow: true };
  }

  let dev;
  try {
    dev = await files.ensureFolder(kv.deviceId(), inbox);
    step('기기 폴더', true, kv.deviceId());
  } catch (e) {
    step('기기 폴더', false, e.message);
    return { ok: false, steps };
  }

  try {
    const f = await files.uploadText(dev, `probe-${Date.now()}.jsonl`,
      JSON.stringify({ id: 'probe', kind: 'probe', at: Date.now() }) + '\n');
    step('파일 올리기', true, f.name);
    const gone = await files.remove(f.id);
    step('시험 파일 지우기', gone, gone ? '' : '남아 있습니다(무해)');
  } catch (e) {
    step('파일 올리기', false, e.message);
    return { ok: false, steps };
  }

  return { ok: true, steps };
}

/* 언제 보낼지(온라인 복귀·앱을 떠날 때·화면 이동·주기)는 **앱 층이 정한다**.
   데이터 층은 DOM 을 모른다 — tools/check-layers.sh 가 그 경계를 지킨다.
   배선은 js/main.js 의 wireUplink() 에 있다. */
