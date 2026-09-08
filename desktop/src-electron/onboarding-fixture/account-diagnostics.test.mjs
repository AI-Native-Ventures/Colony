import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createPassiveAccountDiagnostics } from "./account-diagnostics.mjs";

function fixture() {
  const stderr = new EventEmitter();
  const page = new EventEmitter();
  const diagnostics = createPassiveAccountDiagnostics();
  diagnostics.observeApplication({ process: () => ({ stderr }) });
  diagnostics.observePage(page);
  return { stderr, page, diagnostics };
}

test("passive account diagnostics retain only fixed error categories", () => {
  const { stderr, page, diagnostics } = fixture();
  const secret = "synthetic-password-recovery-token-private-key";
  stderr.emit("data", Buffer.from(`unknown error ${secret}`));
  page.emit("pageerror", new Error(`unknown error ${secret}`));
  assert.deepEqual(diagnostics.snapshot().signals, []);
  stderr.emit(
    "data",
    Buffer.from(`Native command timed out; its result is unknown ${secret}`),
  );
  page.emit("console", {
    type: () => "error",
    text: () => `Native host is disconnected ${secret}`,
  });
  assert.deepEqual(diagnostics.snapshot().signals, [
    { source: "electron-stderr", signal: "native-command-timeout" },
    { source: "page-console", signal: "native-disconnected" },
  ]);
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes(secret));
  diagnostics.close();
});

test("passive diagnostics bound input, deduplicate and detach owned listeners", () => {
  const { stderr, page, diagnostics } = fixture();
  stderr.emit("data", `${"x".repeat(8192)}Native host is disconnected`);
  assert.deepEqual(diagnostics.snapshot().signals, []);
  for (let index = 0; index < 100; index += 1)
    page.emit("pageerror", new Error("Native host pipe closed"));
  assert.equal(diagnostics.snapshot().signals.length, 1);
  const snapshot = diagnostics.snapshot();
  snapshot.signals[0].signal = "mutated-copy";
  assert.equal(diagnostics.snapshot().signals[0].signal, "native-pipe-closed");
  diagnostics.close();
  assert.equal(stderr.listenerCount("data"), 0);
  assert.equal(page.listenerCount("pageerror"), 0);
  assert.equal(page.listenerCount("console"), 0);
  stderr.emit("data", "Native host is disconnected");
  assert.equal(diagnostics.snapshot().signals.length, 1);
});
