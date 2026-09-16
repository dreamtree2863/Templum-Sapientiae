/* drive-files.js — Drive 에 **새 파일을 만든다**(읽기는 drive-api.js).
 *
 *  ‼ 폰은 새 파일만 만들고, 기존 파일은 절대 고치지 않는다.
 *    같은 파일을 PC 와 폰이 함께 고치는 코드 경로가 없어야 Drive 충돌 복사본
 *    (`review (1).json`)이 원천적으로 생기지 않는다.
 *
 *  권한: `drive.file`(앱이 만든 파일만). 폴더를 앱이 직접 만들어 두면 그 아래는
 *  계속 쓸 수 있다. 다만 **Templum 안에 `_inbox` 를 처음 만드는 한 번**이 되는지는
 *  계정에서 직접 해 봐야 안다 — `probe()` 가 그것을 확인한다.
 */
import { driveFetch } from './drive-api.js';
import * as log from '../core/log.js';

const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

let _getToken = () => null;
export function configure({ getToken }) { if (getToken) _getToken = getToken; }

/** 이름으로 하위 폴더를 찾는다(읽기 권한). 없으면 null. */
export async function findFolder(name, parentId) {
  const q = [
    `name='${String(name).replace(/'/g, "\\'")}'`,
    `mimeType='${FOLDER_MIME}'`,
    'trashed=false',
    parentId ? `'${parentId}' in parents` : null,
  ].filter(Boolean).join(' and ');
  const r = await driveFetch('files', { q, fields: 'files(id,name)', pageSize: 10 });
  return r.files?.[0]?.id || null;
}

/** 없으면 만든다. 반환 = 폴더 id. */
export async function ensureFolder(name, parentId) {
  const found = await findFolder(name, parentId);
  if (found) return found;
  const body = { name, mimeType: FOLDER_MIME };
  if (parentId) body.parents = [parentId];
  const r = await createJson(body);
  log.info('drive', `폴더 만듦: ${name}`);
  return r.id;
}

/** 메타데이터만으로 만드는 것(폴더 등). */
async function createJson(body) {
  const resp = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + _getToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorOf(resp);
  return resp.json();
}

/**
 * 텍스트 파일 하나를 올린다(multipart). 반환 {id, name}.
 *
 * ‼ 헤더는 표준인 것만 쓴다 — 비표준 헤더를 붙이면 교차 출처 사전요청에 막혀
 *   요청이 아예 못 나간다(문서 받기에서 실제로 물렸던 함정).
 */
export async function uploadText(folderId, name, text, mime = 'application/json') {
  const meta = { name, parents: folderId ? [folderId] : undefined };
  const boundary = 'tpl' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(meta) +
    `\r\n--${boundary}\r\nContent-Type: ${mime}; charset=UTF-8\r\n\r\n` +
    text +
    `\r\n--${boundary}--\r\n`;

  const resp = await fetch(UPLOAD + '?uploadType=multipart&fields=id,name', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + _getToken(),
      'Content-Type': 'multipart/related; boundary=' + boundary,
    },
    body,
  });
  if (!resp.ok) throw await errorOf(resp);
  return resp.json();
}

export async function remove(fileId) {
  const resp = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId), {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + _getToken() },
  });
  return resp.ok || resp.status === 404;
}

async function errorOf(resp) {
  let detail = '';
  try {
    const d = await resp.json();
    detail = d?.error?.message || '';
  } catch (e) { /* 본문이 없을 수도 있다 */ }
  const e = new Error(`Drive ${resp.status}${detail ? ' — ' + detail : ''}`);
  e.status = resp.status;
  return e;
}
