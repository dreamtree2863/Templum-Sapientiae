/* live.js — Gemini Live(실시간 음성 대화) 세션. 데스크톱 study_manager/core/live_voice.py 의 폰판.
 *
 *  마이크 PCM16 16kHz ─▶ Vertex Live(WebSocket) ─▶ 음성 PCM16 24kHz + 자막
 *                              └ toolCall search_library(query) → 내 자료 검색 결과로 답(근거 유지)
 *
 *  ‼ 데이터 층 — 오디오 장치(DOM·Web Audio)는 features/tutor/voice.js 가 맡는다.
 *  ‼ start() 는 터치 처리 안에서(토큰 만료면 갱신 팝업이 뜬다).
 */
import * as gemini from './gemini.js';
import * as log from '../core/log.js';

export const IN_RATE = 16000;
export const OUT_RATE = 24000;
const VOICE = 'Leda';

const TOOLS = [{ functionDeclarations: [{
  name: 'search_library',
  description: '학습자의 백과사전·아카이브 학습 자료에서 관련 내용을 찾는다(개념·판례·조문·학설·그래프 설명). '
    + '자료 근거가 필요한 질문이면 답하기 전에 먼저 부른다.',
  parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: '찾을 주제·용어(한국어, 짧게)' } }, required: ['query'] },
}] }];

function b64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

/**
 * cb: onReady(model) · onAudio(ArrayBuffer pcm24k) · onInText(조각) · onOutText(조각) · onTurnDone()
 *     onInterrupted() · onTool(query) · onError(msg) · onClosed()
 */
export class LiveSession {
  constructor({ system, history = [], search = null, cb = {}, model = gemini.LIVE }) {
    Object.assign(this, { system, history, search, cb, model });
    this.ws = null;
    this.closing = false;
    this.ready = false;
  }

  emit(name, ...a) { try { this.cb[name]?.(...a); } catch (e) { log.warn('live', name, e); } }

  async start() {
    const ep = await gemini.liveEndpoint();          // 토큰 — 터치 중에
    const tried = [];
    let m = this.model, last = '';
    while (m && !tried.includes(m)) {
      tried.push(m);
      try {
        await this.open(ep, m);
        this.model = m;
        return m;
      } catch (e) {
        last = e.message || String(e);
        log.warn('live', `${m} 세션 실패: ${last}`);
        m = gemini.fallback(m);
      }
    }
    throw new Error(`음성 세션을 열지 못했습니다 (${tried.join(', ')}): ${last}`);
  }

  open(ep, model) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(ep.url);
      let settled = false;
      const fail = (msg) => { if (!settled) { settled = true; try { ws.close(); } catch (e) { /* */ } reject(new Error(msg)); } };
      const timer = setTimeout(() => fail('연결 시간 초과'), 20000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ setup: {
          model: ep.modelPath(model),
          generationConfig: {
            responseModalities: ['AUDIO'], temperature: 0.5,
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } }, languageCode: 'ko-KR' },
          },
          systemInstruction: { parts: [{ text: this.system }] },
          tools: this.search ? TOOLS : [],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} },
        } }));
      };
      ws.onmessage = async (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text()); } catch (e) { return; }
        if (!settled) {
          if (msg.setupComplete) {
            settled = true; clearTimeout(timer);
            this.ws = ws; this.ready = true;
            const turns = (this.history || []).filter(t => (t.text || '').trim())
              .map(t => ({ role: t.role === 'model' ? 'model' : 'user', parts: [{ text: t.text }] }));
            if (turns.length) ws.send(JSON.stringify({ clientContent: { turns, turnComplete: false } }));
            this.emit('onReady', model);
            resolve();
          } else fail('설정 거절: ' + JSON.stringify(msg).slice(0, 160));
          return;
        }
        this.handle(msg);
      };
      ws.onerror = () => fail('연결 오류');
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (!settled) { fail(`연결이 닫혔습니다 (${ev.code}) ${ev.reason || ''}`); return; }
        this.ready = false;
        if (!this.closing && ev.code !== 1000) this.emit('onError', `음성 세션이 끊겼습니다 (${ev.code}) ${ev.reason || ''}`);
        this.emit('onClosed');
      };
    });
  }

  async handle(m) {
    const sc = m.serverContent || {};
    for (const p of sc.modelTurn?.parts || []) {
      if (p.inlineData?.data) this.emit('onAudio', unb64(p.inlineData.data));
    }
    if (sc.inputTranscription?.text) this.emit('onInText', sc.inputTranscription.text);
    if (sc.outputTranscription?.text) this.emit('onOutText', sc.outputTranscription.text);
    if (sc.interrupted) this.emit('onInterrupted');
    if (sc.turnComplete) this.emit('onTurnDone');
    if (m.toolCall) await this.answerTools(m.toolCall);
    if (m.goAway) this.emit('onError', '음성 세션 시간이 끝나 갑니다 — 🎙 를 다시 눌러 이어 가세요.');
  }

  async answerTools(tc) {
    const out = [];
    for (const fc of tc.functionCalls || []) {
      const q = String(fc.args?.query || '').trim();
      this.emit('onTool', q);
      let text = '';
      try { text = this.search ? await this.search(q) : ''; } catch (e) { text = '(검색 실패: ' + e.message + ')'; }
      out.push({ id: fc.id, name: fc.name, response: { result: text || '(학습 자료에서 찾지 못함 — 일반지식은 확실한 것만, 고유 사실은 말하지 말 것)' } });
    }
    if (out.length && this.ws?.readyState === 1) this.ws.send(JSON.stringify({ toolResponse: { functionResponses: out } }));
  }

  sendAudio(pcm16k) {
    if (this.ws?.readyState !== 1) return;
    this.ws.send(JSON.stringify({ realtimeInput: { audio: { mimeType: `audio/pcm;rate=${IN_RATE}`, data: b64(pcm16k) } } }));
  }

  sendText(text) {
    if (this.ws?.readyState !== 1) return;
    this.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }));
  }

  close() {
    this.closing = true;
    try { this.ws?.close(1000); } catch (e) { /* */ }
  }
}
