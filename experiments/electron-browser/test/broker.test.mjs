import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startBroker, requestBroker } from "../src/broker.mjs";

test("local broker returns async results, propagates denial and restricts socket permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "colony-broker-test-"));
  const socketPath = path.join(root, "broker.sock");
  const stop = await startBroker(socketPath, async (request) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (request.token !== "test-only") throw new Error("Access revoked");
    return { seen: request.method };
  });
  try {
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    assert.deepEqual(
      await requestBroker(socketPath, {
        token: "test-only",
        method: "snapshot",
      }),
      { seen: "snapshot" },
    );
    await assert.rejects(
      requestBroker(socketPath, { token: "wrong" }),
      /revoked/,
    );
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});
