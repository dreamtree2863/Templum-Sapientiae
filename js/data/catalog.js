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
import { keepFile, isAudio, audioStem, docStem, classify, segments } from './classify.js';

const ROOT_NAME = 'Templum';
/* ‼ 커서 키를 v2 로 올린 이유 — 실제로 물린 함정이다.
 *   옛 app.js 는 같은 이름(templum.changesToken.v1)을 썼는데, 목록 저장은
 *   localStorage 5MB 한도에 걸려 조용히 실패하면서 커서만 앞으로 감겼다.
 *   그 상태를 물려받으면 목록은 6월 것인데 Drive 는 "변경 없음"만 답한다
 *   — 새로고침을 아무리 눌러도 그 뒤 만들어진 학습지 736편이 영영 안 보인다.
 *   키를 갈아 옛 커서를 한 번 버리고 전체 스캔으로 되돌린다. */
const CHANGES_TOKEN = 'changesToken.v2';
const DEAD_TOKEN = 'changesToken.v1';          // 옛 앱이 남긴 커서 — 믿지 않는다
const OLD_LS_CACHE = 'templum.docList.v9';     // 옛 localStorage 캐시 — 1회 이전 후 삭제

let rootId = null;
let allFiles = [];
let folderMap = {};          // folderId → {name, parentId}
let fetchedAt = 0;
let busy = false;

export const files = () => allFiles;
export const templumId = () => rootId;

/* ── 영속 (IndexedDB) ──────────────────────────────────────────────── */
async function save() {
  try {
    await idb.put('catalog', 'files', allFiles);
    await idb.put('catalog', 'folderMap', folderMap);
    await idb.put('catalog', 'meta', { rootId, fetchedAt, total: allFiles.length });
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
        allFiles = d.allFiles; folderMap = d.folderMap || {}; fetchedAt = d.fetchedAt || 0;
        await save();
        log.info('catalog', `옛 캐시 ${allFiles.length}개를 IndexedDB 로 옮겼습니다`);
      }
      localStorage.removeItem(OLD_LS_CACHE);
    }
  } catch (e) { /* 무시 */ }

  if (!allFiles.length) {
    allFiles = (await idb.get('catalog', 'files')) || [];
    folderMap = (await idb.get('catalog', 'folderMap')) || {};
    const meta = (await idb.get('catalog', 'meta')) || {};
    rootId = meta.rootId || null;
    fetchedAt = meta.fetchedAt || 0;
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
  for (const f of list) {
    if (isAudio(f.name)) continue;
    const info = classify(f);
    const seg = segments(f);
    const audio = audioByKey.get(f.path + '|' + docStem(f.name)) || null;
    const item = { ...f, ...info, seg, audio: audio ? { id: audio.id, name: audio.name } : null };
    const key = [seg.root, seg.kindFolder, seg.subject].filter(Boolean).join('/');
    (groups[key] || (groups[key] = [])).push(item);
    if (seg.root === 'encyclopedia') addToTree(tree, f.path.split('/').slice(1), item);
  }
  return { groups, tree };
}

function addToTree(node, parts, item) {
  if (!parts.length) { (node.__items || (node.__items = [])).push(item); return; }
  const [head, ...rest] = parts;
  addToTree(node[head] || (node[head] = {}), rest, item);
}

/* ── 전체 스캔 ─────────────────────────────────────────────────────── */
async function fullScan(onProgress) {
  rootId = await api.findFolderByName(ROOT_NAME, null);
  if (!rootId) throw new Error(`Drive 에서 '${ROOT_NAME}' 폴더를 찾지 못했습니다.`);
  const collected = [];
  const fmap = {};
  await api.listAllFilesUnder(rootId, {
    keep: keepFile,
    onFolder: (f) => { fmap[f.id] = { name: f.name, parentId: f.parentId }; },
    onBatch: (batch) => {
      collected.push(...batch);
      onProgress?.(collected.length);
      emit(EVENTS.CATALOG_PROGRESS, { count: collected.length });
    },
  });
  allFiles = collected;
  folderMap = fmap;
  fetchedAt = Date.now();
  // 전체를 훑었으니 증분 커서를 지금으로 다시 잡는다
  try { kv.set(CHANGES_TOKEN, await api.fetchStartPageToken()); } catch (e) { kv.del(CHANGES_TOKEN); }
  await save();
  publish();
  return { mode: 'full', total: allFiles.length };
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
  allFiles = Array.from(byId.values());
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

    const cursor = force ? null : kv.get(CHANGES_TOKEN);
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

export function byId(id) { return allFiles.find(f => f.id === id) || null; }
