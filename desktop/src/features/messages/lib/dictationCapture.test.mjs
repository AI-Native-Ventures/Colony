import assert from "node:assert/strict";
import test from "node:test";
import { captureDictation } from "./dictationCapture.ts";
function setup({ permission, moduleFailure = false } = {}) {
  let stops = 0,
    closes = 0,
    node;
  const track = { stop: () => stops++, onended: null };
  const stream = { getTracks: () => [track] };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => permission ?? Promise.resolve(stream),
      },
    },
  });
  globalThis.AudioContext = class {
    sampleRate = 16000;
    state = "running";
    destination = {};
    audioWorklet = {
      addModule: async () => {
        if (moduleFailure) throw new Error("worklet failure");
      },
    };
    resume = async () => {};
    close = async () => {
      closes++;
      this.state = "closed";
    };
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
    createGain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
  };
  globalThis.AudioWorkletNode = class {
    port = {
      close() {},
      onmessage: null,
      postMessage: () => {
        this.port.onmessage({
          data: { samples: new Float32Array([0.2, 0.4]) },
        });
        this.port.onmessage({ data: { finished: true } });
      },
    };
    connect() {}
    disconnect() {}
    constructor() {
      node = this;
    }
  };
  const abort = new AbortController();
  const options = {
    signal: abort.signal,
    level: () => {},
    limit: () => {},
    failed: () => {},
  };
  return {
    options,
    abort,
    stream,
    track,
    node: () => node,
    stops: () => stops,
    closes: () => closes,
  };
}
test("Stop flushes PCM then releases microphone and audio context", async () => {
  const f = setup();
  const capture = await captureDictation(f.options);
  const bytes = await capture.stop();
  assert.equal(bytes.length, 8);
  assert.equal(f.stops(), 1);
  assert.equal(f.closes(), 1);
  capture.cancel();
  assert.equal(f.stops(), 1);
});
test("cancelled late permission releases its track without creating an audio context", async () => {
  let resolve;
  const permission = new Promise((r) => (resolve = r));
  const f = setup({ permission });
  const pending = captureDictation(f.options);
  f.abort.abort();
  resolve(f.stream);
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.stops(), 1);
  assert.equal(f.closes(), 0);
});
test("worklet setup failure releases all acquired audio resources", async () => {
  const f = setup({ moduleFailure: true });
  await assert.rejects(captureDictation(f.options), /worklet failure/);
  assert.equal(f.stops(), 1);
  assert.equal(f.closes(), 1);
});
test("microphone removal reports an actionable error and closes capture", async () => {
  const f = setup();
  let error;
  await captureDictation({
    ...f.options,
    failed: (message) => (error = message),
  });
  f.track.onended();
  assert.match(error, /disconnected/);
  assert.equal(f.closes(), 1);
});
