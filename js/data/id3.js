/* id3.js — mp3 앞머리에서 낭독 타이밍을 읽어 낸다.
 *
 *  데스크톱은 타이밍을 mp3 의 ID3 태그에 박아 둔다(`tts_common._read_embedded_timing`,
 *  TXXX 프레임, desc = "TTS_TIMING", 값 = JSON {v, method, sig, starts}).
 *
 *  실측(무작위 60편): ID3v2 태그는 **언제나 파일 맨 앞**에 있고 크기는 중앙값 7.4KB,
 *  최대 44KB. 그래서 앞 64KB 만 Range 로 받으면 타이밍을 얻는다 — 몇 MB짜리 mp3 를
 *  끝까지 받지 않고도 하이라이트를 시작할 수 있다. 이게 폰에서 결정적이다.
 *
 *  starts 는 초가 아니라 **전체 길이에 대한 비율(0~1)** 이다(데스크톱 archive.js 와 동일).
 */

export const HEAD_BYTES = 64 * 1024;

/** 앞머리 바이트 → {v, method, sig, starts} | null */
export function readTiming(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;   // "ID3"
  const major = b[3];
  const flags = b[5];
  const size = syncsafe(b, 6);
  let p = 10;
  if (flags & 0x40) p += readInt(b, p, 4, major >= 4);       // 확장 헤더는 건너뛴다
  const end = Math.min(b.length, 10 + size);

  while (p + 10 <= end) {
    const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;                    // 패딩에 닿았다
    // ‼ v2.4 는 프레임 크기도 syncsafe, v2.3 은 그냥 32비트. 섞어 읽으면 프레임이 밀려
    //   태그 전체를 못 읽는다(값이 통째로 사라진 것처럼 보인다).
    const len = readInt(b, p + 4, 4, major >= 4);
    const body = p + 10;
    if (len <= 0 || body + len > end) break;
    if (id === 'TXXX') {
      const t = readTxxx(b.subarray(body, body + len));
      if (t && t.desc === 'TTS_TIMING') return parse(t.value);
    }
    p = body + len;
  }
  return null;
}

function syncsafe(b, o) { return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]; }
function readInt(b, o, n, sync) {
  if (sync) return syncsafe(b, o);
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 8) | b[o + i];
  return v >>> 0;
}

/** TXXX 본문 = [인코딩 1바이트][설명][널][값] */
function readTxxx(body) {
  if (!body.length) return null;
  const enc = body[0];
  const rest = body.subarray(1);
  if (enc === 0x01 || enc === 0x02) return utf16Txxx(rest, enc === 0x01);
  const dec = new TextDecoder(enc === 0x03 ? 'utf-8' : 'windows-1252');
  const z = rest.indexOf(0);
  if (z < 0) return null;
  return { desc: dec.decode(rest.subarray(0, z)), value: dec.decode(rest.subarray(z + 1)) };
}

/** UTF-16 은 널 구분자도 2바이트다 — 1바이트로 자르면 설명과 값이 뒤섞인다. */
function utf16Txxx(rest, hasBom) {
  let z = -1;
  for (let i = 0; i + 1 < rest.length; i += 2) {
    if (rest[i] === 0 && rest[i + 1] === 0) { z = i; break; }
  }
  if (z < 0) return null;
  const dec = (a) => new TextDecoder(hasBom ? 'utf-16' : 'utf-16be').decode(a).replace(/^﻿/, '');
  return { desc: dec(rest.subarray(0, z)), value: dec(rest.subarray(z + 2)) };
}

function parse(json) {
  try {
    // ‼ 값 끝에 널 종결자가 붙어 오는 경우가 있다(실측 mutagen 출력).
    //   그대로 JSON.parse 하면 던져서 "타이밍 없음"으로 보인다 — 실제로 물린 함정.
    const d = JSON.parse(String(json).replace(/\0+$/, ''));
    if (!Array.isArray(d?.starts) || !d.starts.length) return null;
    return { v: Number(d.v) || 1, method: d.method || '', sig: d.sig || '', starts: d.starts };
  } catch (e) { return null; }
}

/**
 * 이 타이밍을 써도 되는가.
 *
 * ‼ 데스크톱(`timing_is_current`)은 세그먼트 지문(md5)까지 맞춰 보지만 폰은 **개수만** 본다.
 *   지문을 다시 계산하려면 낭독 정규화 200줄이 파이썬과 글자 하나까지 같아야 하는데,
 *   실측 일치율이 99.5% 였다. 한 세그먼트만 달라도 지문이 깨져 늘 heuristic 으로
 *   떨어지므로, 깨지기 쉬운 정확함 대신 개수 확인 + 어긋나면 비례 배분으로 간다.
 */
export function usable(t, segCount) {
  if (!t || !Array.isArray(t.starts)) return false;
  if (t.starts.length !== segCount) return false;
  if (t.method === 'manual') return true;
  return (t.v || 1) >= 2;            // whisper 는 v2(제목 구간 실측) 이상만
}

/** 타이밍이 없을 때의 폴백 — 글자 수에 비례해 나눈다(데스크톱 archive.js 와 같은 규칙). */
export function proportional(texts) {
  const lens = texts.map(t => (t && t.length) || 1);
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const out = [];
  let acc = 0;
  for (const L of lens) { out.push(+(acc / total).toFixed(5)); acc += L; }
  return out;
}
