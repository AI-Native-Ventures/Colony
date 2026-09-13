import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import fs from "node:fs";
function processor() {
  let Processor;
  const messages = [];
  vm.runInNewContext(
    fs.readFileSync(
      new URL("../../../../public/dictation-worklet.js", import.meta.url),
      "utf8",
    ),
    {
      AudioWorkletProcessor: class {
        port = { postMessage: (message) => messages.push(message) };
      },
      registerProcessor: (_name, klass) => {
        Processor = klass;
      },
      Float32Array,
    },
  );
  return { p: new Processor(), messages };
}
test("Stop flushes the exact final partial frame before completion", () => {
  const { p, messages } = processor();
  for (let i = 0; i < 14; i++) p.process([[new Float32Array(128).fill(0.25)]]);
  p.port.onmessage({ data: "stop" });
  assert.deepEqual(
    messages.filter((m) => m.samples).map((m) => m.samples.length),
    [1600, 192],
  );
  assert.equal(messages.at(-1).finished, true);
  assert.equal(p.process([[new Float32Array(128)]]), false);
  p.port.onmessage({ data: "stop" });
  assert.equal(messages.filter((m) => m.finished).length, 1);
});
test("capture cannot exceed sixty seconds even when the main-thread timer is delayed", () => {
  const { p, messages } = processor();
  for (let i = 0; i < 7600; i++) p.process([[new Float32Array(128)]]);
  assert.equal(
    messages.filter((m) => m.samples).reduce((n, m) => n + m.samples.length, 0),
    960000,
  );
  assert.equal(messages.filter((m) => m.finished).length, 1);
});
