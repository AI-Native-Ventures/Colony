// Dedicated composer capture: 16 kHz mono, bounded, and explicitly flushed.
class DictationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1600);
    this.offset = 0;
    this.total = 0;
    this.finished = false;
    this.port.onmessage = ({ data }) => {
      if (data === "stop") this.finish();
    };
  }
  flush() {
    if (!this.offset) return;
    const samples = this.buffer.slice(0, this.offset);
    this.port.postMessage({ samples }, [samples.buffer]);
    this.offset = 0;
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.flush();
    this.port.postMessage({ finished: true });
  }
  process(inputs) {
    if (this.finished) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      this.buffer[this.offset++] = Math.max(-1, Math.min(1, sample));
      this.total++;
      if (this.offset === this.buffer.length) this.flush();
      if (this.total >= 16000 * 60) {
        this.finish();
        return false;
      }
    }
    return true;
  }
}
registerProcessor("colony-dictation", DictationProcessor);
