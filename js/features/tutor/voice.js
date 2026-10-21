/* voice.js — 학습 챗봇 🎙 음성 대화(폰). 마이크·스피커(Web Audio) + Live 세션(data/live.js) 연결.
 *  데스크톱 appshell/voice.py 의 VoiceController 와 같은 흐름:
 *    자막 누적 → 턴 확정(turn) → 채팅 기록 · 사실 점검
 *  에코: 기본은 반이중(튜터가 말하는 동안 +0.35초 마이크를 보내지 않음). 이어폰이면 끼어들기 허용.
 *
 *  ‼ start() 는 터치 처리 안에서 — 마이크 권한·AudioContext 재생 허용·토큰 갱신이 모두 터치를 요구한다.
 */
import { live, tutor } from '../../data/index.js';

const TAIL_MS = 350;

export class VoiceController {
  /** ui: {status(msg), userPartial(text), modelPartial(text), turn(u, m, interrupted), stopped(reason), level(v)} */
  constructor(ui) {
    this.ui = ui;
    this.session = null;
    this.fullDuplex = false;
    this.lastSearch = '';
    this.inText = ''; this.outText = '';
    this.playUntil = 0;
    this.sources = [];
    this.stopReason = '';
  }

  active() { return !!this.session; }

  async start(system, history) {
    // 1) 오디오 — 터치 중에 만든다(재생 허용)
    this.outCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.nextAt = 0;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      this.outCtx.close().catch(() => {});
      throw new Error('마이크를 쓸 수 없습니다 — 권한을 허용해 주세요 (' + (e.name || e.message) + ')');
    }
    this.stream = stream;
    this.inCtx = new (window.AudioContext || window.webkitAudioContext)();
    await this.inCtx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url));
    const src = this.inCtx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.inCtx, 'mic-16k');
    this.node.port.onmessage = (ev) => {
      this.ui.level?.(ev.data.level);
      if (!this.session?.ready) return;
      if (!this.fullDuplex && this.playing()) return;        // 반이중: 튜터 목소리가 다시 들어가지 않게
      this.session.sendAudio(ev.data.pcm);
    };
    src.connect(this.node);                                   // 출력에 잇지 않는다(내 소리를 내가 듣지 않게)
    try { this.wake = await navigator.wakeLock?.request('screen'); } catch (e) { /* 화면 켜짐 유지 실패는 무시 */ }

    // 2) 세션
    this.inText = ''; this.outText = ''; this.stopReason = '';
    this.ui.status('🎙 음성 세션 연결 중…');
    this.session = new live.LiveSession({
      system: system + tutor.VOICE_RULES,
      history,
      search: async (q) => { const t = await tutor.voiceSearch(q); this.lastSearch = t; return t; },
      cb: {
        onReady: (m) => this.ui.status(`🎙 듣는 중 — 말하세요 · 다시 누르면 끝 (${m})`),
        onAudio: (buf) => this.play(buf),
        onInText: (s) => {
          if (this.outText && !this.inText) this.finalize(true);    // 튜터가 말하던 중 끼어듦 → 앞 턴 확정
          this.inText += s; this.ui.userPartial(this.inText.trim());
        },
        onOutText: (s) => { this.outText += s; this.ui.modelPartial(this.outText.trim()); },
        onTurnDone: () => {
          if (!this.outText.trim()) return;                        // 도구 호출로 끝난 턴 — 답 턴을 기다린다
          this.finalize(false);
          this.ui.status('🎙 듣는 중 — 말하세요 · 다시 누르면 끝');
        },
        onInterrupted: () => { this.flush(); this.finalize(true); },
        onTool: (q) => this.ui.status(`🎙 자료 찾는 중… 「${q.slice(0, 30)}」`),
        onError: (msg) => this.ui.status('🎙 ' + msg),
        onClosed: () => this.teardown(),
      },
    });
    try {
      await this.session.start();
    } catch (e) {
      this.teardown();
      throw e;
    }
  }

  setFullDuplex(on) { this.fullDuplex = !!on; }

  sendText(text) {
    if (!this.session) return;
    this.inText = text; this.ui.userPartial(text);
    this.session.sendText(text);
  }

  stop(reason = '') {
    this.stopReason = reason;
    this.finalize(!!this.outText);
    if (this.session) this.session.close();
    else this.teardown();
  }

  /* ── 재생 ── */
  playing() { return performance.now() < this.playUntil; }

  play(buf) {
    const ctx = this.outCtx;
    if (!ctx) return;
    const pcm = new Int16Array(buf);
    const ab = ctx.createBuffer(1, pcm.length, live.OUT_RATE);
    const ch = ab.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const s = ctx.createBufferSource();
    s.buffer = ab;
    s.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, this.nextAt);
    s.start(at);
    this.nextAt = at + ab.duration;
    this.sources.push(s);
    s.onended = () => { this.sources = this.sources.filter(x => x !== s); };
    this.playUntil = performance.now() + (this.nextAt - ctx.currentTime) * 1000 + TAIL_MS;
  }

  flush() {                         // 끼어들기 — 아직 안 나간 소리를 버린다
    for (const s of this.sources) { try { s.stop(); } catch (e) { /* */ } }
    this.sources = [];
    this.nextAt = 0;
    this.playUntil = 0;
  }

  finalize(interrupted) {
    const u = this.inText.trim(), m = this.outText.trim();
    this.inText = ''; this.outText = '';
    if (u || m) this.ui.turn(u, m, interrupted);
  }

  teardown() {
    if (!this.session && !this.stream) return;
    this.session = null;
    try { this.node?.disconnect(); } catch (e) { /* */ }
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.flush();
    this.inCtx?.close().catch(() => {}); this.inCtx = null;
    this.outCtx?.close().catch(() => {}); this.outCtx = null;
    try { this.wake?.release(); } catch (e) { /* */ }
    this.ui.stopped(this.stopReason);
  }
}
