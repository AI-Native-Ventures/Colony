import test from "node:test";
import assert from "node:assert/strict";
import { Cleanup } from "./cleanup.mjs";
test("a failed flush cannot skip host or broker shutdown; cleanup runs once", async () => {
  const cleanup = new Cleanup();
  const called = [];
  cleanup.add(() => {
    called.push("flush");
    throw Error("disk unavailable");
  });
  cleanup.add(async () => {
    called.push("broker");
  });
  cleanup.add(async () => {
    called.push("host");
  });
  const first = cleanup.run();
  assert.equal(cleanup.run(), first);
  const result = await first;
  assert.deepEqual(called, ["flush", "broker", "host"]);
  assert.deepEqual(
    result.map((r) => r.status),
    ["rejected", "fulfilled", "fulfilled"],
  );
});
