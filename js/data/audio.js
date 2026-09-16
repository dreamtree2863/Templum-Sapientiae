/* audio.js — 낭독 mp3.
 *
 *  실측: Drive 에 낭독 mp3 937편(백과 564 · 아카이브 321). 문서와 같은 폴더에
 *  `<문서>_낭독.mp3` 로 놓여 있고, catalog 가 문서에 붙여 준다(file.audio).
 *
 *  ‼ mp3 를 통째로 받지 않는다.
 *    · 타이밍은 앞 64KB 만 Range 로 받아 ID3 에서 꺼낸다(실측 태그 중앙값 7.4KB).
 *    · 재생은 <audio src=…> 로 흘린다. Authorization 은 서비스워커가 끼워 주고
 *      206(Range) 응답을 그대로 통과시킨다(sw.js) — 그래서 탐색·이어듣기가 된다.
 *      ‼ <audio> 요소는 반드시 **부모 페이지**에 만들어야 한다. 문서는 blob: iframe
 *        이라 서비스워커가 잡지 못해, 거기서 만들면 인증이 안 붙는다.
 */
import { readTiming, usable, proportional, HEAD_BYTES } from './id3.js';
import * as log from '../core/log.js';

const MEDIA = 'https://www.googleapis.com/drive/v3/files/';

let _getToken = () => null;
export function configure({ getToken }) { if (getToken) _getToken = getToken; }

/** <audio src> 에 그대로 넣는 주소. 인증은 서비스워커가 붙인다. */
export function streamUrl(fileId) {
  return MEDIA + encodeURIComponent(fileId) + '?alt=media';
}

/** 앞머리만 받아 타이밍을 꺼낸다. 없으면 null — 호출부가 비례 배분으로 간다. */
export async function fetchTiming(fileId) {
  try {
    const resp = await fetch(streamUrl(fileId), {
      headers: { Authorization: 'Bearer ' + _getToken(), Range: 'bytes=0-' + (HEAD_BYTES - 1) },
    });
    if (!resp.ok && resp.status !== 206) return null;
    const t = readTiming(await resp.arrayBuffer());
    if (t) log.info('audio', `타이밍 ${t.method} v${t.v} · ${t.starts.length}구간`);
    return t;
  } catch (e) {
    log.warn('audio', '타이밍을 읽지 못했습니다', e);
    return null;
  }
}

/** 세그먼트 수에 맞는 starts 를 고른다 — 임베드 타이밍이 못 미더우면 글자수 비례. */
export function startsFor(timing, texts) {
  return usable(timing, texts.length) ? timing.starts : proportional(texts);
}
