/* scans.js — 스캔한 쪽을 Drive 에 올리고, 답안이면 PC 로 알린다.
 *
 *  올리는 곳:  Templum/스캔/<YYYYMMDD-HHMMSS> <제목>/p01.jpg … + <제목>.pdf
 *              (`_` 로 시작하지 않으니 Drive 에서 사람이 바로 찾는다)
 *  문제가 딸리면 사건 {kind:'scan'} 을 _inbox 로 → PC core/mobile_scans.py 가 그 폴더를
 *  Drive 마운트에서 복사해 채점 화면 📱 폰 답안 목록(📷)에 올린다.
 *
 *  ‼ 화상 처리(자르기·펴기·보정)는 화면 층(features/scan/imaging.js) — 여기는 DOM 을 모른다.
 *  ‼ 찍는 중에 앱이 죽어도 남게 원본 사진·모서리를 IndexedDB(state: scan:draft)에 적는다.
 */
import * as files from './drive-files.js';
import * as outbox from './outbox.js';
import * as uplink from './uplink.js';
import * as auth from './auth.js';
import * as catalog from './catalog.js';
import * as idb from '../core/idb.js';
import * as log from '../core/log.js';

export const ROOT_NAME = '스캔';
const DRAFT = 'scan:draft';

export const loadDraft = () => idb.get('state', DRAFT).catch(() => null);
export const saveDraft = (d) => idb.put('state', DRAFT, d).catch(e => log.warn('scan', '임시 저장 실패', e));
export const clearDraft = () => idb.del('state', DRAFT).catch(() => {});

/** 보내기 버튼 처리기 맨 앞에서 — 쓰기 토큰을 터치 안에서 받아 둔다. */
export const ensureWrite = () => auth.writeToken();

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
/** Drive·Windows 양쪽에서 문제없는 이름 — PC 가 G: 마운트로 같은 이름을 찾는다. */
export function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim()
    .replace(/^\.+|\.+$/g, '').slice(0, 60) || '스캔';
}

/**
 * 보낸다. pages = [Blob(jpeg)], pdf = Blob, problem = 카탈로그 파일(없으면 null).
 * onProgress(text) 로 단계를 알린다. 반환 {folder, pdfName, queued}
 */
export async function send({ title, problem, pages, pdf, onProgress = () => {} }) {
  if (!navigator.onLine) throw new Error('오프라인입니다 — 연결되면 다시 보내 주세요(찍은 것은 남아 있습니다)');
  if (!auth.getWriteToken()) await auth.writeToken();
  const root = catalog.templumId();
  if (!root) throw new Error('Drive 에서 Templum 폴더를 찾지 못했습니다 — 목록을 새로고침해 주세요');

  const name = safeName(title);
  const folderName = `${stamp()} ${name}`;
  onProgress('Drive 폴더 준비…');
  const scanRoot = await files.ensureFolder(ROOT_NAME, root);
  const folderId = await files.ensureFolder(folderName, scanRoot);

  const pageNames = [];
  let bytes = 0;
  for (let i = 0; i < pages.length; i++) {
    const pn = `p${String(i + 1).padStart(2, '0')}.jpg`;
    onProgress(`사진 올리는 중 ${i + 1}/${pages.length}…`);
    await files.uploadBlob(folderId, pn, pages[i], 'image/jpeg');
    pageNames.push(pn);
    bytes += pages[i].size;
  }
  const pdfName = `${name}.pdf`;
  if (pdf) {
    onProgress(`PDF 올리는 중 (${(pdf.size / 1048576).toFixed(1)}MB)…`);
    await files.uploadBlob(folderId, pdfName, pdf, 'application/pdf');
  }
  log.info('scan', `${pages.length}쪽 올림 → ${ROOT_NAME}/${folderName} (${(bytes / 1048576).toFixed(1)}MB)`);

  let queued = false;
  if (problem) {
    await outbox.enqueue({
      kind: 'scan', mode: 'answer',
      docId: problem.id, name: problem.name, path: problem.path,
      title, folder: `${ROOT_NAME}/${folderName}`, folderId,
      pages: pageNames, pdf: pdf ? pdfName : '', finishedAt: Date.now(),
    });
    await uplink.flush({ silent: true }).catch(() => {});
    queued = true;
  }
  return { folder: `${ROOT_NAME}/${folderName}`, pdfName, queued };
}
