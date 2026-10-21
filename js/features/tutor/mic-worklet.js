/* mic-worklet.js — 마이크(장치 표본률) → 16kHz mono PCM16, 100ms 묶음으로 메인 스레드에 보낸다.
 *  청크 경계가 끊기지 않게 소수 위치를 이어 가는 선형 보간(음성 인식에 충분). */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;   // 입력 몇 표본마다 출력 하나
    this.pos = 0;                     // 다음 출력 표본의 입력 위치(현재 블록 기준)
    this.out = new Int16Array(1600);
    this.n = 0;
    this.level = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    this.level = Math.sqrt(sum / ch.length);
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const a = ch[i];
      const b = i + 1 < ch.length ? ch[i + 1] : ch[i];
      let v = a + (b - a) * f;
      v = Math.max(-1, Math.min(1, v));
      this.out[this.n++] = v * 32767;
      if (this.n === this.out.length) {
        this.port.postMessage({ pcm: this.out.buffer.slice(0), level: this.level });
        this.n = 0;
      }
      this.pos += this.step;
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor('mic-16k', MicProcessor);
