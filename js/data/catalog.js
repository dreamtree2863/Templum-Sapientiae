/* catalog.js — Drive 의 Templum 폴더에 무엇이 있는지 아는 곳.
 *
 *  ‼ 옛 app.js 의 loadDocuments / applyDriveChanges / resolvePathLive / saveCache 를 옮겼다.
 *    로직은 그대로, 바꾼 것은 둘:
 *      · 끝에 박혀 있던 renderList() 호출 제거 → catalog:changed 통지만
 *      · 캐시를 localStorage → **IndexedDB** 로 (9,335개 목록이 5MB 한도에 걸려
 *        조용히 저장 실패하던 문제. 옛 app.js:245 의 `catch(_) {}`)
 */
import * as api from './drive-api.js';
import * as idb from '../core/idb.js';
import * as kv from '../core/kv.js';
import * as log from '../core/log.js';
import { patch, get } from '../core/store.js';
import { emit, EVENTS } from '../core/bus.js';
import { keepFile, isAudio, audioStem, docStem, classify, segments, isHiddenPath } from './classify.js';

const ROOT_NAME = 'Templum';
/* ‼ 커서 키를 v2 로 올린 이유 — 실제로 물린 함정이다.
 *   옛 app.js 는 같은 이름(templum.changesToken.v1)을 썼는데, 목록 저장은
 *   localStorage 5MB 한도에 걸려 조용히 실패하면서 커서만 앞으로 감겼다.
 *   그 상태를 물려받으면 목록은 6월 것인데 Drive 는 "변경 없음"만 답한다
 *   — 새로고침을 아무리 눌러도 그 뒤 만들어진 학습지 736편이 영영 안 보인다.
 *   키를 갈아 옛 커서를 한 번 버리고 전체 스캔으로 되돌린다. */
/* ‼ 목록이 **무엇을 담는지**가 바뀌면 이 번호를 올린다.
 *   그러면 앱이 스스로 한 번 전체를 다시 훑는다.
 *   왜 필요한가 — 폰에 남아 있는 목록은 옛 규칙으로 만들어진 것이다.
 *   예를 들어 `_state/*.json`(복습 카드·객관식 은행)은 담기지 않던 시절의 목록이라,
 *   코드를 고쳐도 목록을 다시 받기 전까지는 그 파일을 영영 못 찾는다.
 *   사용자가 "전체 다시 훑기"를 눌러야만 고쳐지는 상태를 남기지 않는다. */
const CATALOG_EPOCH = 2;

const CHANGES_TOKEN = 'changesToken.v2';
const DEAD_TOKEN = 'changesToken.v1';          // 옛 앱이 남긴 커서 — 믿지 않는다
const OLD_LS_CACHE = 'templum.docList.v9';     // 옛 localStorage 캐시 — 1회 이전 후 삭제

let rootId = null;
let allFiles = [];
let folderMap = {};          // folderId → {name, parentId}
let fetchedAt = 0;
let busy = false;
let itemById = new Map();   // id → 오디오·종류가 붙은 항목(build 가 채운다)
let staleEpoch = false;     // 옛 규칙으로 만든 목록 — 한 번 전체를 다시 받아야 한다

export const files = () => allFiles;
export const templumId = () => rootId;

/** 목록이 어디서 왔든(전체 스캔·증분·물려받은 옛 캐시) 내부 폴더는 털어 낸다.
 *
 *  ‼ 한글 경로는 **정규화 형태**를 여기서 한 번에 NFC 로 맞춘다.
 *    Drive 가 NFD("ㅂㅐㄱㅈㅣ")로 돌려주면, 앱 안의 NFC 문자열("백지")과 겉보기는
 *    같은데 비교가 어긋나 폴더가 통째로 빈 것처럼 보인다. 들어오는 길목에서 맞춰 두면
 *    그 뒤 모든 비교가 안전하다.
 */
function sanitize(list) {
  return list.filter(f => !isHiddenPath(f.path)).map(f => {
    const path = (f.path || '').normalize('NFC');
    const name = (f.name || '').normalize('NFC');
    return (path === f.path && name === f.name) ? f : { ...f, path, name };
  });
}

/* ── 영속 (IndexedDB) ──────────────────────────────────────────────── */
async function save() {
  try {
    await idb.put('catalog', 'files', allFiles);
    await idb.put('catalog', 'folderMap', folderMap);
    await idb.put('catalog', 'meta', {
      rootId, fetchedAt, total: allFiles.length, epoch: CATALOG_EPOCH,
    });
  } catch (e) { log.warn('catalog', '캐시 저장 실패', e); }
}

export async function load() {
  try { kv.del(DEAD_TOKEN); } catch (e) { /* 무시 */ }

  // 옛 localStorage 캐시가 남아 있으면 한 번만 옮겨 담고 비운다
  try {
    const legacy = localStorage.getItem(OLD_LS_CACHE);
    if (legacy) {
      const d = JSON.parse(legacy);
      if (d?.allFiles?.length) {
        allFiles = sanitize(d.allFiles); folderMap = d.folderMap || {}; fetchedAt = d.fetchedAt || 0;
        await save();
        log.info('catalog', `옛 캐시 ${allFiles.length}개를 IndexedDB 로 옮겼습니다`);
      }
      localStorage.removeItem(OLD_LS_CACHE);
    }
  } catch (e) { /* 무시 */ }

  if (!allFiles.length) {
    allFiles = sanitize((await idb.get('catalog', 'files')) || []);
    folderMap = (await idb.get('catalog', 'folderMap')) || {};
    const meta = (await idb.get('catalog', 'meta')) || {};
    rootId = meta.rootId || null;
    fetchedAt = meta.fetchedAt || 0;
    if (allFiles.length && (Number(meta.epoch) || 0) !== CATALOG_EPOCH) {
      staleEpoch = true;
      log.info('catalog', '옛 규칙으로 만든 목록 — 다음 새로고침에 전체를 다시 받습니다');
    }
  }
  publish();
  return allFiles.length;
}

/* ── 파생: 그룹·트리 ───────────────────────────────────────────────── */
function publish() {
  const { groups, tree } = build(allFiles);
  patch('catalog', { files: allFiles, groups, tree, fetchedAt, total: allFiles.length });
  emit(EVENTS.CATALOG_CHANGED, { total: allFiles.length, fetchedAt });
}

/** 문서에 낭독 오디오를 붙이고(같은 폴더·같은 stem), 경로별로 묶는다. */
function build(list) {
  const audioByKey = new Map();
  for (const f of list) {
    if (isAudio(f.name)) audioByKey.set(f.path + '|' + audioStem(f.name), f);
  }
  const groups = {};      // "archive/백지 인출/경제학" 같은 상위 경로 → 항목 배열
  const tree = {};        // 백과사전 폴더 트리
  itemById = new Map();   // ‼ byId 가 돌려줄 것 — 낭독 오디오·종류가 붙은 항목
  for (const f of list) {
    if (isAudio(f.name)) continue;
    const info = classify(f);
    const seg = segments(f);
    const audio = audioByKey.get(f.path + '|' + docStem(f.name)) || null;
    const item = { ...f, ...info, seg, audio: audio ? { id: audio.id, name: audio.name } : null };
    const key = [seg.root, seg.kindFolder, seg.subject].filter(Boolean).join('/');
    (groups[key] || (groups[key] = [])).push(item);
    itemById.set(f.id, item);
    if (seg.root === 'encyclopedia') addToTree(tree, f.path.split('/').slice(1), item);
  }
  return { groups, tree };
}

function addToTree(node, parts, item) {
  if (!parts.length) { (node.__items || (node.__items = [])).push(item); return; }
  const [head, ...rest] = parts;
  addToTree(node[head] || (node[head] = {}), rest, item);
}

/* ── 전체 스캔 ───────────────────────────────────────────────────────
 *
 *  ‼ 폰에서 이 스캔이 **끝까지 못 가는 것**이 실제 문제였다.
 *    Templum 아래 폴더가 570여 개인데, 옛 구조는 끝날 때까지 아무것도 저장하지
 *    않았다. 화면이 꺼지거나 앱이 뒤로 가면 통째로 날아가고 다음에 처음부터 —
 *    그래서 새로고침을 아무리 눌러도 학습지가 영영 0편이었다.
 *
 *    이제 남은 일감과 여기까지 모은 것을 중간중간 저장하고, 다음 번에 **이어서**
 *    한다. 중간 결과도 바로 화면에 보여 준다(숫자가 오르는 것이 보여야 한다).
 */
const SCAN_KEY = 'scan';          // idb 'catalog' — {rootId, stack, files, folderMap, at}
const SCAN_TTL = 24 * 3600 * 1000;

async function fullScan(onProgress) {
  rootId = await api.findFolderByName(ROOT_NAME, null);
  if (!rootId) throw new Error(`Drive 에서 '${ROOT_NAME}' 폴더를 찾지 못했습니다.`);

  let collected = [];
  let fmap = {};
  let stack = null;

  // 하다 만 것이 있으면 이어서
  const saved = await idb.get('catalog', SCAN_KEY).catch(() => null);
  if (saved && saved.rootId === rootId && Date.now() - (saved.at || 0) < SCAN_TTL
      && Array.isArray(saved.stack) && saved.stack.length) {
    collected = saved.files || [];
    fmap = saved.folderMap || {};
    stack = saved.stack;
    log.info('catalog', `하다 만 스캔을 이어서 — ${collected.length}개까지 받아 둠, 남은 폴더 ${stack.length}개`);
  }

  const checkpoint = async (remaining) => {
    if (remaining.length) {
      await idb.put('catalog', SCAN_KEY, {
        rootId, stack: remaining, files: collected, folderMap: fmap, at: Date.now(),
      }).catch(() => {});
      // 아직 다 못 받았어도 여기까지는 쓸 수 있게 공개한다
      allFiles = sanitize(dedupe(collected));
      folderMap = fmap;
      publish();
    } else {
      await idb.del('catalog', SCAN_KEY).catch(() => {});
    }
  };

  await api.listAllFilesUnder(rootId, {
    keep: keepFile,
    stack,
    onCheckpoint: checkpoint,
    onFolder: (f) => { fmap[f.id] = { name: f.name, parentId: f.parentId }; },
    onBatch: (batch) => {
      collected.push(...batch);
      onProgress?.(collected.length);
      emit(EVENTS.CATALOG_PROGRESS, { count: collected.length });
    },
  });

  allFiles = sanitize(dedupe(collected));
  folderMap = fmap;
  fetchedAt = Date.now();
  // 전체를 훑었으니 증분 커서를 지금으로 다시 잡는다
  try { kv.set(CHANGES_TOKEN, await api.fetchStartPageToken()); } catch (e) { kv.del(CHANGES_TOKEN); }
  staleEpoch = false;
  await save();
  publish();
  log.info('catalog', `전체 스캔 완료 — ${allFiles.length}개`);
  return { mode: 'full', total: allFiles.length };
}

/** 이어 하다 같은 폴더를 두 번 훑었을 수 있다 — id 로 한 번만 남긴다. */
function dedupe(list) {
  const m = new Map();
  for (const f of list) m.set(f.id, f);
  return Array.from(m.values());
}

/* ── 증분 ──────────────────────────────────────────────────────────── */

/** 폴더 id → Templum 하위 상대경로. 모르는 폴더는 한 건씩 물어 배운다. null = Templum 밖. */
async function resolvePath(parentId) {
  const parts = [];
  let cur = parentId, guard = 0;
  while (cur && cur !== rootId && guard++ < 40) {
    let node = folderMap[cur];
    if (!node) {
      try {
        const r = await api.fileParents(cur);
        node = { name: r.name, parentId: (r.parents && r.parents[0]) || null };
        folderMap[cur] = node;
      } catch (e) { return null; }
    }
    parts.unshift(node.name);
    cur = node.parentId;
  }
  return (cur === rootId) ? parts.join('/') : null;
}

/** 변경을 반영. 구조가 흔들렸으면 false → 호출부가 전체 스캔으로 간다. */
async function applyChanges(entries) {
  if (!allFiles.length || !Object.keys(folderMap).length) return false;
  const byId = new Map(allFiles.map(f => [f.id, f]));
  for (const c of entries) {
    const id = c.fileId || c.file?.id;
    if (!id) continue;
    const f = c.file;
    if (c.removed || f?.trashed) {
      if (folderMap[id]) return false;         // 추적하던 폴더가 사라짐 → 하위 경로 전부 영향
      byId.delete(id);
      continue;
    }
    if (!f) continue;
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      const under = !!folderMap[id] || (await resolvePath(f.parents?.[0] || null)) !== null;
      if (under) return false;                 // Templum 안 폴더 생성/이름변경/이동 → 전체 스캔
      continue;
    }
    if (!keepFile(f.name)) { byId.delete(id); continue; }
    const path = await resolvePath(f.parents?.[0] || null);
    if (path === null) { byId.delete(id); continue; }   // Templum 밖으로 나감
    byId.set(id, {
      id, name: f.name,
      mtime: Date.parse(f.modifiedTime) || 0,
      size: Number(f.size) || 0,
      path,
    });
  }
  allFiles = sanitize(Array.from(byId.values()));
  fetchedAt = Date.now();
  await save();
  publish();
  return true;
}

/* ── 바깥에서 부르는 것 ────────────────────────────────────────────── */

/**
 * 최신으로 맞춘다. 증분을 먼저 시도하고 안 되면 전체 스캔.
 * 중복 호출은 조용히 무시한다(당겨서 새로고침 연타 방어).
 */
export async function refresh({ force = false, onProgress } = {}) {
  if (busy) return { skipped: true };
  busy = true;
  patch('catalog', { loading: true });
  try {
    if (!rootId) rootId = await api.findFolderByName(ROOT_NAME, null);

    // 옛 규칙으로 만든 목록이면 증분으로 고칠 수 없다 — 한 번은 전체를 받아야 한다
    const cursor = (force || staleEpoch) ? null : kv.get(CHANGES_TOKEN);
    if (staleEpoch) log.info('catalog', '목록 형식이 바뀌어 전체를 다시 받습니다');
    if (cursor && allFiles.length) {
      try {
        const { entries, newToken } = await api.fetchChanges(cursor);
        if (!entries.length) {
          if (newToken) kv.set(CHANGES_TOKEN, newToken);
          fetchedAt = Date.now();
          await save(); publish();
          return { mode: 'nochange', total: allFiles.length };
        }
        if (await applyChanges(entries)) {
          if (newToken) kv.set(CHANGES_TOKEN, newToken);
          log.info('catalog', `증분 ${entries.length}건 반영`);
          return { mode: 'incremental', changed: entries.length, total: allFiles.length };
        }
        log.info('catalog', '구조가 바뀌어 전체 스캔으로 전환');
      } catch (e) {
        log.warn('catalog', '증분 실패 — 전체 스캔', e);
        kv.del(CHANGES_TOKEN);
      }
    }
    return await fullScan(onProgress);
  } finally {
    busy = false;
    patch('catalog', { loading: false });
  }
}

/** 문서에서 상대경로 링크를 눌렀을 때 같은 폴더에서 찾아 준다. */
export function resolveRelative(fromFile, href) {
  const name = decodeURIComponent(String(href).split(/[?#]/)[0]).replace(/^\.\//, '');
  if (name.includes('/')) return null;
  return allFiles.find(f => f.path === fromFile.path && f.name === name) || null;
}

/* ‼ 낭독 오디오가 붙은 **항목**을 돌려준다.
 *   날 파일 목록(allFiles)에는 audio 가 없다 — 그것만 돌려주던 탓에
 *   음성이 있는 문서인데도 뷰어에 낭독 단추가 뜨지 않았다. */
export function byId(id) { return itemById.get(id) || allFiles.find(f => f.id === id) || null; }
