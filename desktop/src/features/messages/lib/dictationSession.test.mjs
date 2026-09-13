import assert from "node:assert/strict";
import test from "node:test";
import { createDictationSession } from "./dictationSession.ts";
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function fixture(overrides = {}) {
  const inserted = [];
  const states = [];
  let cancelled = 0;
  const recording = {
    stop: async () => new Uint8Array([1]),
    cancel: () => {
      cancelled++;
    },
  };
  const session = createDictationSession({
    prepare: async () => {},
    capture: async () => recording,
    transcribe: async () => "hello",
    insert: (text) => inserted.push(text),
    changed: (state) => states.push(state),
    ...overrides,
  });
  return { session, inserted, states, recording, cancelled: () => cancelled };
}
test("Stop returns an editable transcript exactly once", async () => {
  const f = fixture();
  await f.session.start();
  assert.equal(f.session.busy(), true);
  await Promise.all([f.session.stop(), f.session.stop()]);
  assert.deepEqual(f.inserted, ["hello"]);
  assert.equal(f.session.busy(), false);
  f.session.cancel();
});
test("cancel during permission releases late microphone and inserts nothing", async () => {
  const pending = deferred();
  const f = fixture({ capture: () => pending.promise });
  const start = f.session.start();
  await new Promise(setImmediate);
  f.session.cancel();
  pending.resolve(f.recording);
  await start;
  assert.equal(f.cancelled(), 1);
  assert.deepEqual(f.inserted, []);
  assert.equal(f.session.busy(), false);
});
test("cancel during decode ignores a late transcript", async () => {
  const pending = deferred();
  const f = fixture({ transcribe: () => pending.promise });
  await f.session.start();
  const stop = f.session.stop();
  await new Promise(setImmediate);
  f.session.cancel();
  pending.resolve("wrong destination");
  await stop;
  assert.deepEqual(f.inserted, []);
});
test("cancel during stop does not start transcription", async () => {
  const pending = deferred();
  let calls = 0;
  const f = fixture({
    capture: async () => ({ stop: () => pending.promise, cancel: () => {} }),
    transcribe: async () => {
      calls++;
      return "bad";
    },
  });
  await f.session.start();
  const stop = f.session.stop();
  f.session.cancel();
  pending.resolve(new Uint8Array());
  await stop;
  assert.equal(calls, 0);
  assert.deepEqual(f.inserted, []);
});
test("permission and recognition failures remain retryable and preserve draft", async () => {
  const f = fixture({
    capture: async () => {
      throw new Error("Microphone denied");
    },
  });
  await f.session.start();
  assert.equal(f.session.busy(), false);
  assert.match(f.states.at(-1).error, /Microphone denied/);
  assert.deepEqual(f.inserted, []);
  f.session.cancel();
  const g = fixture({
    transcribe: async () => {
      throw new Error("Decode failed");
    },
  });
  await g.session.start();
  await g.session.stop();
  assert.equal(g.session.busy(), false);
  assert.match(g.states.at(-1).error, /Decode failed/);
  assert.deepEqual(g.inserted, []);
  g.session.cancel();
});
test("silence never inserts empty text", async () => {
  const f = fixture({ transcribe: async () => "  " });
  await f.session.start();
  await f.session.stop();
  assert.deepEqual(f.inserted, []);
  assert.match(f.states.at(-1).error, /speech/i);
  f.session.cancel();
});
test("duplicate starts and a second composer cannot acquire a second microphone", async () => {
  let captures = 0;
  const f = fixture({
    capture: async () => {
      captures++;
      return { stop: async () => new Uint8Array(), cancel: () => {} };
    },
  });
  await Promise.all([f.session.start(), f.session.start()]);
  const g = fixture();
  await g.session.start();
  assert.equal(captures, 1);
  assert.match(g.states.at(-1).error, /another/i);
  f.session.cancel();
  g.session.cancel();
});
