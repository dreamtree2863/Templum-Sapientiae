/* gemini.js — Gemini 호출 단일 창구 (Vertex AI · tts3 클라우드 크레딧).
 *
 *  2026-10-21: AI Studio 키는 선불 크레딧이 소진(402)돼 쓰지 않는다. tts3 의 Gemini API 키도
 *  같은 선불로 청구돼 402 → **Vertex 만** 산다. 앱 로그인 토큰(cloud-platform)으로 브라우저에서
 *  바로 부른다(CORS·SSE·Live 모두 확인). 데스크톱 ai_models.py 와 같은 모델 표를 쓴다 — 고칠 때 둘 다.
 *
 *  ‼ 데이터 층 — DOM 을 만지지 않는다.
 *  ‼ cloudToken() 은 터치 처리 안에서 먼저 불러야 한다(만료 시 팝업). 그래서 화면은
 *    generate/stream 을 *버튼 처리기 맨 앞*에서 부른다.
 */
import * as auth from './auth.js';
import * as kv from '../core/kv.js';
import * as log from '../core/log.js';

export const PROJECT = () => kv.get('ai.vertex.project') || 'tts3-507713';
const LOCATION = 'global';
export const LIVE_LOCATION = 'us-central1';       // Live 는 지역 엔드포인트만 있다

/* 데스크톱 ai_models.py 와 같은 표 */
export const PRO = 'gemini-4-argon';
export const FLASH = 'gemini-3.6-flash';            // 3.8-flash 는 tts3 에서 용량 부족(429·무응답)이 잦았다
export const LITE = 'gemini-3.5-flash-lite';
export const LIVE = 'gemini-3.8-live';
const FALLBACK = {
  'gemini-3.8-flash': 'gemini-3.6-flash',
  'gemini-3.6-flash': 'gemini-3-flash-preview',
  'gemini-4-argon': 'gemini-3.1-pro-preview',
  'gemini-3.5-flash-lite': 'gemini-3.1-flash-lite',
  'gemini-3.8-live': 'gemini-live-2.5-flash-native-audio',
};
export const fallback = (m) => FALLBACK[m] || null;
const thinks = (m) => /gemini-(\d+)/.test(m) && Number(/gemini-(\d+)/.exec(m)[1]) >= 3;
const capTokens = (m, n) => (m === PRO ? Math.min(n, 32768) : n);

const url = (model, method) =>
  `https://aiplatform.googleapis.com/v1/projects/${PROJECT()}/locations/${LOCATION}/publishers/google/models/${encodeURIComponent(model)}:${method}`;

/** 생성 설정 — thinking 은 3세대부터 low 로(속도·비용). */
export function genConfig(model, { maxOutputTokens = 8192, temperature = 0.4, json = false, thinking = 'low' } = {}) {
  const c = { maxOutputTokens: capTokens(model, maxOutputTokens), temperature };
  if (thinks(model) && thinking) c.thinkingConfig = { thinkingLevel: thinking };
  if (json) c.responseMimeType = 'application/json';
  return c;
}

const capacity = (status, msg) => status === 429 || status === 503 || status === 404
  || /RESOURCE_EXHAUSTED|overloaded|UNAVAILABLE/i.test(msg || '');

async function errorOf(resp) {
  let detail = '';
  try { detail = (await resp.json())?.error?.message || ''; } catch (e) { /* 본문 없음 */ }
  const e = new Error(`AI 응답 실패 (${resp.status})${detail ? ' — ' + detail.slice(0, 160) : ''}`);
  e.status = resp.status; e.detail = detail;
  if (resp.status === 401 || resp.status === 403) e.needCloud = true;
  return e;
}

const textOf = (d) => (d?.candidates?.[0]?.content?.parts || [])
  .filter(p => !p.thought).map(p => p.text || '').join('');

/**
 * 한 번 묻고 전체 응답(JSON)을 받는다. 용량 부족이면 대체 모델로 한 번 더.
 * body = {contents, systemInstruction?, tools?} — generationConfig 는 opts 로.
 */
export async function generateRaw(body, { model = FLASH, ...opts } = {}) {
  const token = await auth.cloudToken();
  let m = model;
  for (let tries = 0; tries < 3 && m; tries++) {
    const resp = await fetch(url(m, 'generateContent'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ ...body, generationConfig: genConfig(m, opts) }),
    });
    if (resp.ok) return { data: await resp.json(), model: m };
    const e = await errorOf(resp);
    if (!capacity(e.status, e.detail) || !fallback(m)) throw e;
    log.warn('gemini', `${m} 용량 부족 → ${fallback(m)}`);
    m = fallback(m);
  }
  throw new Error('AI 응답 실패 — 모델이 모두 바쁩니다');
}

/** 글만 받는다. */
export async function generate(promptText, { system = '', ...opts } = {}) {
  const body = { contents: [{ role: 'user', parts: [{ text: promptText }] }] };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const { data } = await generateRaw(body, opts);
  const t = textOf(data).trim();
  if (!t) throw new Error('AI 가 빈 답을 보냈습니다');
  return t;
}

/** JSON 으로만 답하게 한 호출(목차 채점 등). */
export async function generateJson(promptText, opts = {}) {
  let text = await generate(promptText, { temperature: 0.1, ...opts, json: true });
  text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch (e) { throw new Error('AI 응답을 읽지 못했습니다: ' + text.slice(0, 120)); }
}

/**
 * 대화(여러 턴) 스트리밍 — onDelta(지금까지의 글) 를 여러 번 부른다. 반환 전체 글.
 * turns = [{role:'user'|'model', text}]. 첫 조각 전 용량 부족이면 대체 모델로.
 */
export async function stream(turns, { system = '', onDelta, model = FLASH, signal, ...opts } = {}) {
  const token = await auth.cloudToken();
  const body = {
    contents: turns.filter(t => (t.text || '').trim())
      .map(t => ({ role: t.role === 'model' ? 'model' : 'user', parts: [{ text: t.text }] })),
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  let m = model;
  for (let tries = 0; tries < 3 && m; tries++) {
    const resp = await fetch(url(m, 'streamGenerateContent') + '?alt=sse', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ ...body, generationConfig: genConfig(m, opts) }),
    });
    if (!resp.ok) {
      const e = await errorOf(resp);
      if (!capacity(e.status, e.detail) || !fallback(m)) throw e;
      m = fallback(m);
      continue;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', out = '', finish = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let d;
        try { d = JSON.parse(line.slice(5)); } catch (e) { continue; }
        const piece = textOf(d);
        if (piece) { out += piece; onDelta?.(out); }
        finish = d?.candidates?.[0]?.finishReason || finish;
      }
    }
    if (finish && finish !== 'STOP' && out) out += '\n\n_(답이 길어 여기서 끊겼습니다 — "이어서"라고 하면 계속합니다)_';
    if (!out.trim()) throw new Error('AI 가 빈 답을 보냈습니다');
    return out;
  }
  throw new Error('AI 응답 실패 — 모델이 모두 바쁩니다');
}

/** Google 검색 근거를 붙여 묻는다(사실 점검). 반환 {text, sources[]} */
export async function groundedJson(promptText, opts = {}) {
  const body = { contents: [{ role: 'user', parts: [{ text: promptText }] }], tools: [{ googleSearch: {} }] };
  const { data } = await generateRaw(body, { temperature: 0, maxOutputTokens: 8192, ...opts });
  const cand = data?.candidates?.[0] || {};
  const sources = [];
  for (const ch of cand.groundingMetadata?.groundingChunks || []) {
    const t = (ch.web?.title || '').trim();
    if (t && !sources.includes(t)) sources.push(t);
  }
  return { text: textOf(data), sources: sources.slice(0, 6) };
}

/** Live(음성 대화) 접속 정보 — 브라우저 WebSocket 은 헤더를 못 넣어 토큰을 주소에 싣는다. */
export async function liveEndpoint() {
  const token = await auth.cloudToken();
  return {
    url: `wss://${LIVE_LOCATION}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent?access_token=${encodeURIComponent(token)}`,
    modelPath: (m) => `projects/${PROJECT()}/locations/${LIVE_LOCATION}/publishers/google/models/${m}`,
  };
}
