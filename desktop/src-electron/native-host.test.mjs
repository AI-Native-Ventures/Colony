import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { NativeHost, nativeRequestTimeout } from "./native-host.mjs";

test("only the bounded native updater commands receive transfer time", () => {
  assert.equal(
    nativeRequestTimeout("invoke", "plugin:updater|download", 60_000),
    16 * 60_000,
  );
  assert.equal(nativeRequestTimeout("invoke", "sign_out", 60_000), 60_000);
  assert.equal(
    nativeRequestTimeout("emit", "plugin:updater|download", 60_000),
    60_000,
  );
});
function fixture(t) {
  const child = new EventEmitter();
  const requests = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      requests.push(JSON.parse(chunk));
      done();
    },
  });
  child.kill = () => {
    queueMicrotask(() => child.emit("exit"));
    return true;
  };
  const host = new NativeHost("test", {
    spawnProcess: () => child,
    timeout: 1000,
  });
  const send = (message) =>
    child.stdout.write(`@colony-native:${JSON.stringify(message)}\n`);
  t.after(() => host.fail("Test cleanup"));
  send({ type: "ready", version: 1 });
  return { host, child, requests, send };
}
test("out of order responses retain native error values", async (t) => {
  const { host, requests, send } = fixture(t);
  const first = host.request("invoke", { command: "a" });
  const second = host.request("invoke", { command: "b" });
  await new Promise((resolve) => setImmediate(resolve));
  send({
    type: "response",
    id: requests[1].id,
    error: "relay rate-limited: retry",
  });
  send({ type: "response", id: requests[0].id, result: { ok: true } });
  await assert.rejects(second, (e) => e === "relay rate-limited: retry");
  assert.deepEqual(await first, { ok: true });
  assert.equal(host.pending.size, 0);
});
test("fragmented frames and legacy diagnostics do not lose pushes", (t) => {
  const { host, child } = fixture(t);
  const events = [];
  host.on("event", (e) => events.push(e));
  child.stdout.write("legacy diagnostic\n@colony-na");
  child.stdout.write('tive:{"type":"event","id":3,"payload":false}\n');
  assert.deepEqual(events, [{ type: "event", id: 3, payload: false }]);
});
test("host exit rejects pending and future commands", async (t) => {
  const { host, child } = fixture(t);
  const pending = host.request("invoke", { command: "a" });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit");
  await assert.rejects(pending, /exited/);
  await assert.rejects(host.request("invoke"), /disconnected/);
  assert.equal(host.pending.size, 0);
});
test("malformed frames fail closed without echoing their contents", (t) => {
  const { host, child } = fixture(t);
  let reason;
  host.on("disconnected", (s) => (reason = s));
  child.stdout.write("@colony-native:null\n");
  assert.equal(reason, "Malformed native response");
});

test("shutdown kills a resistant owned child and waits for exit", async () => {
  const child = new EventEmitter();
  const signals = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") setImmediate(() => child.emit("exit"));
    return true;
  };
  const host = new NativeHost("fixture", {
    spawnProcess: () => child,
    shutdownGrace: 5,
    timeout: 1000,
  });
  child.stdout.write('@colony-native:{"type":"ready","version":1}\n');
  await host.ready;
  await host.close();
  assert.equal(host.childExited, true);
  assert.deepEqual(signals, ["SIGKILL"]);
});
