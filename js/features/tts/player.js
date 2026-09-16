/* player.js — 낭독 재생. 문서를 보며 따라 읽고, 화면을 꺼도 이어진다.
 *
 *  ‼ 하이라이트 엔진은 새로 짜지 않는다. 데스크톱의 `tts_player.js` 를 그대로 싣고
 *    (vendor/tts_player.js) 우리가 "저장된 mp3 한 덩어리"를 건네는 방식이다.
 *    데스크톱 archive.js 의 fileSynthPlan/fileSynthChunk 와 같은 계약:
 *        synthPlan(texts)  → {chunks:[{seg_from:0, seg_to:n}]}
 *        synthChunk(0)     → {ok, audio_url, starts, seg_from, seg_to}
 *    starts 는 초가 아니라 **전체 길이에 대한 비율(0~1)** 이다.
 *
 *  ‼ <audio> 는 부모 페이지에 만든다. 문서는 blob: iframe 이라 서비스워커가 잡지
 *    못해, 그 안에서 만들면 Drive 인증이 안 붙는다(소리가 안 난다).
 *
 *  MediaSession — 잠금화면·이어폰 버튼. 폰에서만 얻을 수 있는 것이라 여기서 붙인다.
 */
import { audio as audioData } from '../../data/index.js';
import * as shell from '../shell.js';
import * as log from '../../core/log.js';

const VENDOR = './vendor/tts_player.js';

let player = null;      // createTTSPlayer 인스턴스
let el = null;          // <audio> (부모 페이지)
let cur = null;         // {file, frame}
let onStateCb = null;

/** vendor/tts_player.js 를 부모 페이지에 한 번만 싣는다. */
function ensureVendor() {
  if (window.createTTSPlayer) return Promise.resolve(true);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = VENDOR;
    s.onload = () => resolve(!!window.createTTSPlayer);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

export function available(file) { return !!(file && file.audio); }

/**
 * 문서 하나의 낭독을 준비한다(재생은 start 로).
 *   file  카탈로그 항목 — file.audio.{id,name} 이 있어야 한다
 *   frame 문서 iframe — 하이라이트는 이 안에서 일어난다
 */
export async function attach(file, frame, { onState } = {}) {
  stop();
  if (!available(file) || !frame?.contentDocument) return false;
  if (!(await ensureVendor())) { log.warn('tts', '플레이어를 싣지 못했습니다'); return false; }

  cur = { file, frame };
  onStateCb = onState || null;

  el = el || new Audio();
  el.preload = 'none';

  // 타이밍은 앞 64KB 만 받아 읽는다 — 재생 시작을 막지 않도록 미리 걸어 둔다
  const timingP = audioData.fetchTiming(file.audio.id);
  let texts = [];

  player = window.createTTSPlayer(frame.contentDocument, {
    audioEl: el,
    synthPlan: (t) => { texts = (t || []).slice(); return Promise.resolve({ chunks: [{ seg_from: 0, seg_to: texts.length }] }); },
    synthChunk: async (idx) => {
      if (idx !== 0) return { ok: false };
      const timing = await timingP;
      const starts = audioData.startsFor(timing, texts);
      if (!timing) shell.toast('타이밍이 없어 글자수로 맞춥니다', 'info');
      else if (timing.starts.length !== texts.length) {
        // 문서가 바뀌었는데 낭독을 다시 만들지 않은 경우 — 조용히 틀리면 안 된다
        log.warn('tts', `타이밍 ${timing.starts.length}구간 ≠ 문단 ${texts.length}개 → 비례 배분`);
        shell.toast('낭독이 문서와 조금 어긋납니다', 'info');
      }
      return { ok: true, audio_url: audioData.streamUrl(file.audio.id), starts, seg_from: 0, seg_to: texts.length };
    },
    onState: (st) => { setMediaState(st); onStateCb?.(st); },
  });

  setupMediaSession(file);
  return true;
}

export function start() { player?.start(); }
export function toggle() {
  if (!player) return;
  if (el && !el.paused) { el.pause(); setMediaState('paused'); return; }
  if (el && el.currentTime > 0 && el.src) { el.play().catch(() => {}); setMediaState('playing'); return; }
  player.start();
}
export function stop() {
  try { player?.stop(); } catch (e) { /* 무시 */ }
  player = null; cur = null;
  if (el) { try { el.pause(); } catch (e) {} el.removeAttribute('src'); }
  setMediaState('none');
}
export function playing() { return !!(el && !el.paused && el.src); }

/* ── 잠금화면 · 이어폰 ─────────────────────────────────────────────── */

function setupMediaSession(file) {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const title = (file.baseTitle || file.name || '').replace(/\.html?$/i, '');
  const where = (file.path || '').split('/').slice(-2).join(' · ');
  try {
    ms.metadata = new MediaMetadata({ title, artist: where, album: 'Templum Sapientiae' });
  } catch (e) { /* 메타데이터가 없어도 재생은 된다 */ }

  const set = (k, fn) => { try { ms.setActionHandler(k, fn); } catch (e) {} };
  set('play', () => { el?.play().catch(() => {}); setMediaState('playing'); });
  set('pause', () => { el?.pause(); setMediaState('paused'); });
  set('stop', () => stop());
  set('seekbackward', (d) => nudge(-(d?.seekOffset || 10)));
  set('seekforward', (d) => nudge(d?.seekOffset || 10));
  set('seekto', (d) => { if (el && d?.seekTime != null) el.currentTime = d.seekTime; });
  // 이전/다음 = 문단 단위 — 낭독에서 "트랙"은 문단이 가장 쓸모 있다
  set('previoustrack', () => nudge(-15));
  set('nexttrack', () => nudge(15));
}

function nudge(sec) {
  if (!el || !el.duration) return;
  el.currentTime = Math.min(el.duration, Math.max(0, el.currentTime + sec));
}

function setMediaState(st) {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    ms.playbackState = st === 'playing' ? 'playing' : st === 'paused' ? 'paused' : 'none';
  } catch (e) { /* 무시 */ }
}

export function element() { return el; }
export function current() { return cur; }
