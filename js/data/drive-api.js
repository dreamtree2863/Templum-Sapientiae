/* drive-api.js — Google Drive REST 호출의 단일 관문.
 *
 *  ‼ 옛 app.js:366-445 를 로직 그대로 옮긴 것이다. 잘 돌던 코드라 손대지 않았고,
 *    바꾼 것은 둘뿐:
 *      · 전역 state.accessToken → getToken() 주입
 *      · 401 에서 autoSignInIfPossible() 직접 호출 → onUnauthorized() 콜백
 *    덕분에 이 파일은 화면도 인증 구현도 모른다.
 */
import * as log from '../core/log.js';

const BASE = 'https://www.googleapis.com/drive/v3/';

let _getToken = () => null;
let _onUnauthorized = () => {};

/** auth.js 가 기동할 때 한 번 물려 준다. */
export function configure({ getToken, onUnauthorized }) {
  if (getToken) _getToken = getToken;
  if (onUnauthorized) _onUnauthorized = onUnauthorized;
}

/**
 * Drive 는 일시적으로 500/502/503 이나 429(속도제한)를 준다.
 * 지수 백오프로 최대 4회 재시도 — 한 번의 일시 오류로 동기화가 깨지지 않게.
 * 401 은 재시도하지 않고 재인증을 트리거한 뒤 던진다.
 */
export async function driveFetch(path, params) {
  const url = new URL(BASE + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) {
      await new Promise(r => setTimeout(r, 400 * (2 ** (attempt - 1)) + Math.random() * 300));
    }
    let resp;
    try {
      resp = await fetch(url.toString(), {
        headers: { Authorization: 'Bearer ' + _getToken() },
        cache: 'no-store',          // 브라우저 HTTP 캐시 우회 → 항상 Drive 최신
      });
    } catch (e) {
      lastErr = e;                  // 네트워크 일시 오류 → 재시도
      continue;
    }
    if (resp.status === 401) {
      _onUnauthorized();
      throw new Error('토큰 만료 — 자동 재로그인 시도 중. 잠시 후 다시 시도해 주세요.');
    }
    if (resp.status === 429 || resp.status >= 500) {
      lastErr = new Error('Drive API ' + resp.status + ' ' + resp.statusText);
      continue;
    }
    if (!resp.ok) throw new Error('Drive API ' + resp.status + ' ' + resp.statusText);
    return resp.json();
  }
  log.warn('drive', '재시도 초과', lastErr);
  throw lastErr || new Error('Drive API 요청 실패(재시도 초과)');
}

export async function findFolderByName(name, parentId) {
  const q = [
    `name='${name.replace(/'/g, "\\'")}'`,
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
  ];
  if (parentId) q.push(`'${parentId}' in parents`);
  const res = await driveFetch('files', { q: q.join(' and '), fields: 'files(id,name)' });
  return res.files?.[0]?.id || null;
}

/** 폴더 하나를 훑는다 — 재개 가능한 스캔의 최소 단위. */
async function listOneFolder(id, path, keep) {
  const files = [];
  const folders = [];
  let pageToken;
  do {
    const params = {
      q: `'${id}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,size)',
      pageSize: 1000,
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await driveFetch('files', params);
    for (const f of (res.files || [])) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        folders.push({ id: f.id, name: f.name, parentId: id, path: [...path, f.name] });
      } else if (!keep || keep(f.name, path)) {
        files.push({
          id: f.id,
          name: f.name,
          mtime: Date.parse(f.modifiedTime),
          size: Number(f.size) || 0,
          path: path.join('/'),       // Templum 내부 상대 경로
        });
      }
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  return { files, folders };
}

/**
 * 하위 폴더까지 훑어 문서·오디오 파일을 전부 수집한다.
 *   onBatch(batch[])              파일을 찾을 때마다 — 진행 표시·중간 저장용
 *   onFolder({id,name,parentId})  폴더 발견 시 — 폴더맵 구축(증분 동기화에 필수)
 *   keep(name)                    이 파일을 담을지 판정 (classify.js 가 준다)
 *   onCheckpoint(stack)           남은 일감 — 여기서 끊겨도 이어 갈 수 있게
 *   stack                         이어 할 지점(앞서 받은 checkpoint)
 *
 * ‼ 폰에서 이 스캔이 끝까지 못 가는 것이 실제 문제였다. 폴더가 570여 개인데
 *   하나씩 차례로 물으면 몇 분이 걸리고, 그 사이 화면이 꺼지거나 앱이 뒤로 가면
 *   통째로 날아가 다음에 **처음부터** 다시 했다. 그래서 둘을 고쳤다:
 *     · 여러 폴더를 동시에 묻는다(오가는 횟수를 몇 분의 일로)
 *     · 남은 일감을 밖으로 흘려 중간에 저장해 두게 한다
 */
export async function listAllFilesUnder(folderId, {
  onBatch, onFolder, keep, onCheckpoint, stack: resume, concurrency = 5,
} = {}) {
  const stack = (resume && resume.length) ? resume.slice() : [{ id: folderId, path: [] }];
  let since = 0;

  while (stack.length) {
    const take = stack.splice(0, concurrency);
    let results;
    try {
      results = await Promise.all(take.map(n => listOneFolder(n.id, n.path, keep)));
    } catch (e) {
      stack.unshift(...take);                       // 실패한 묶음은 되돌려 놓는다
      if (onCheckpoint) await onCheckpoint(stack);  // 여기까지는 살린다
      throw e;
    }
    for (const r of results) {
      for (const f of r.folders) {
        stack.push({ id: f.id, path: f.path });
        if (onFolder) onFolder({ id: f.id, name: f.name, parentId: f.parentId });
      }
      if (r.files.length && onBatch) onBatch(r.files);
      since += r.files.length;
    }
    if (onCheckpoint && since >= 400) { since = 0; await onCheckpoint(stack); }
  }
  if (onCheckpoint) await onCheckpoint([]);         // 다 끝났다
}

/* ── 증분 동기화 (Drive Changes API) ─────────────────────────────────── */

export async function fetchStartPageToken() {
  const res = await driveFetch('changes/startPageToken', {});
  return res.startPageToken || null;
}

/**
 * 커서 이후의 변경을 모아 온다. 반환 {entries, newToken}.
 * newToken 이 null 이면 커서가 무효 — 호출 측이 전체 스캔으로 폴백해야 한다.
 */
export async function fetchChanges(pageToken) {
  const entries = [];
  let token = pageToken;
  for (let guard = 0; guard < 100 && token; guard++) {
    const res = await driveFetch('changes', {
      pageToken: token,
      pageSize: 200,
      restrictToMyDrive: true,
      fields: 'newStartPageToken,nextPageToken,'
            + 'changes(fileId,removed,file(id,name,mimeType,createdTime,modifiedTime,size,parents,trashed))',
    });
    entries.push(...(res.changes || []));
    if (res.newStartPageToken) return { entries, newToken: res.newStartPageToken };
    token = res.nextPageToken;
  }
  return { entries, newToken: token || null };
}

/** 파일 하나의 부모를 알아낸다 — 폴더맵에 없는 폴더를 학습할 때. */
export async function fileParents(fileId) {
  const res = await driveFetch('files/' + fileId, { fields: 'id,name,parents' });
  return res;
}
