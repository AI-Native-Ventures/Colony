import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RendererHost } from "./renderer-host.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(handle = () => undefined) {
  const host = new EventEmitter();
  host.ready = Promise.resolve();
  host.sequence = 0;
  host.nextId = () => ++host.sequence;
  const calls = [];
  host.request = async (type, payload, id = host.nextId()) => {
    const call = { type, payload, id };
    calls.push(call);
    return (await handle(call, host)) ?? (type === "listen" ? id : null);
  };
  return { host, calls, bridge: new RendererHost(host) };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("renderer reset cancels native update download before waiting for it", async () => {
  const downloading = deferred();
  const { bridge, calls } = fixture((call) => {
    if (call.payload.command === "electron_check_for_update")
      return { rid: 41, version: "0.17.0" };
    if (call.payload.command === "electron_download_update")
      return downloading.promise;
    if (
      call.payload.command === "plugin:resources|close" &&
      call.payload.args.rid === 41
    )
      downloading.reject("Update cancelled");
  });
  await bridge.request("invoke", { command: "electron_check_for_update" });
  const old = bridge.request("invoke", {
    command: "electron_download_update",
    args: { rid: 41 },
  });
  const rejected = assert.rejects(old, (error) => error === "Update cancelled");
  await tick();
  await bridge.reset();
  await rejected;
  await bridge.request("invoke", { command: "fresh" });
  assert.equal(calls.at(-1).payload.command, "fresh");
  assert.equal(bridge.updates.size, 0);
});

test("an update check completing after reload is retired before the new view starts", async () => {
  const checking = deferred();
  const { bridge, calls } = fixture((call) => {
    if (call.payload.command === "electron_check_for_update")
      return checking.promise;
  });
  const old = bridge.request("invoke", {
    command: "electron_check_for_update",
  });
  const rejected = assert.rejects(old, /renderer changed/);
  await tick();
  const reset = bridge.reset();
  const fresh = bridge.request("invoke", { command: "fresh" });
  checking.resolve({ rid: 42, version: "0.17.0" });
  await Promise.all([reset, fresh, rejected]);
  const retired = calls.findIndex(
    (call) =>
      call.payload.command === "plugin:resources|close" &&
      call.payload.args.rid === 42,
  );
  assert.ok(retired >= 0);
  assert.ok(
    retired < calls.findIndex((call) => call.payload.command === "fresh"),
  );
});

test("an explicit update close in flight is not repeated during reset", async () => {
  const closing = deferred();
  const { bridge, calls } = fixture((call) => {
    if (call.payload.command === "electron_check_for_update")
      return { rid: 43, version: "0.17.0" };
    if (call.payload.command === "plugin:resources|close")
      return closing.promise;
  });
  await bridge.request("invoke", { command: "electron_check_for_update" });
  const old = bridge.request("invoke", {
    command: "plugin:resources|close",
    args: { rid: 43 },
  });
  const rejected = assert.rejects(old, /renderer changed/);
  await tick();
  const reset = bridge.reset();
  closing.resolve();
  await Promise.all([reset, rejected]);
  assert.equal(
    calls.filter((call) => call.payload.command === "plugin:resources|close")
      .length,
    1,
  );
});

test("reload never reuses native channel ids and drops delayed old pushes", async () => {
  const { bridge, host, calls } = fixture();
  const delivered = [];
  bridge.on("channel", (message) => delivered.push(message));
  const args = { nested: [{ channel: "__CHANNEL__:11" }] };
  await bridge.request("invoke", { command: "stream", args });
  const oldId = Number(calls[0].payload.args.nested[0].channel.split(":")[1]);
  host.emit("channel", { id: oldId, sequence: 0, payload: "before" });
  await bridge.reset();
  await bridge.request("invoke", { command: "stream", args });
  const newId = Number(
    calls.at(-1).payload.args.nested[0].channel.split(":")[1],
  );
  assert.notEqual(newId, oldId);
  host.emit("channel", { id: oldId, sequence: 1, payload: "stale" });
  host.emit("channel", { id: newId, sequence: 0, payload: "after" });
  assert.deepEqual(
    delivered.map(({ id, payload }) => [id, payload]),
    [
      [11, "before"],
      [11, "after"],
    ],
  );
});

test("early events arrive; pending old listens are retired before new invokes", async () => {
  const listening = deferred();
  let first = true;
  const { bridge, host, calls } = fixture((call, native) => {
    if (call.type === "listen" && first) {
      first = false;
      native.emit("event", { id: call.id, payload: "early" });
      return listening.promise;
    }
  });
  const delivered = [];
  bridge.on("event", (message) => delivered.push(message.payload));
  const oldListen = bridge.request("listen", { event: "fixture" });
  const rejectedOldListen = assert.rejects(oldListen, /renderer changed/);
  await tick();
  assert.deepEqual(delivered, ["early"]);
  const oldId = calls[0].id;
  const reset = bridge.reset();
  host.emit("event", { id: oldId, payload: "stale" });
  const fresh = bridge.request("invoke", { command: "fresh" });
  await tick();
  assert.equal(calls.length, 1);
  listening.resolve(oldId);
  await Promise.all([reset, fresh, rejectedOldListen]);
  assert.ok(
    calls.some(
      (call) => call.type === "unlisten" && call.payload.subscription === oldId,
    ),
  );
  assert.equal(calls.at(-1).payload.command, "fresh");
  const newId = await bridge.request("listen", { event: "fixture" });
  host.emit("event", { id: oldId, payload: "still stale" });
  host.emit("event", { id: newId, payload: "fresh event" });
  assert.deepEqual(delivered, ["early", "fresh event"]);
});

test("old calls waiting for native readiness cannot begin after reset", async () => {
  const ready = deferred();
  const { bridge, host, calls } = fixture();
  host.ready = ready.promise;
  const old = bridge.request("invoke", { command: "old" });
  const rejected = assert.rejects(old, /renderer changed/);
  await tick();
  const reset = bridge.reset();
  ready.resolve();
  await Promise.all([reset, rejected]);
  assert.equal(
    calls.some((call) => call.payload.command === "old"),
    false,
  );
});

test("pending native creations finish before retirement and their old result is rejected", async () => {
  const creating = deferred();
  const { bridge, calls } = fixture((call) =>
    call.payload.command === "create" ? creating.promise : undefined,
  );
  const old = bridge.request("invoke", { command: "create" });
  const rejected = assert.rejects(old, /renderer changed/);
  await tick();
  const reset = bridge.reset();
  await tick();
  assert.equal(calls.length, 1);
  creating.resolve("created");
  await Promise.all([reset, rejected]);
  assert.deepEqual(
    calls.slice(1).map((call) => call.payload.command),
    ["plugin:websocket|disconnect_all", "workspace_terminal_close_all"],
  );
});

test("cleanup failure rejects new work while still attempting every cleanup", async () => {
  const { bridge, calls } = fixture((call) => {
    if (call.payload.command === "plugin:websocket|disconnect_all")
      throw "fixture cleanup failure";
  });
  await assert.rejects(bridge.reset(), /cleanup failed/);
  await assert.rejects(
    bridge.request("invoke", { command: "must not run" }),
    /cleanup failed/,
  );
  assert.deepEqual(
    calls.map((call) => call.payload.command),
    ["plugin:websocket|disconnect_all", "workspace_terminal_close_all"],
  );
});

test("channel exhaustion fails rather than wrapping and reusing an old id", async () => {
  const { bridge, calls } = fixture();
  bridge.nextChannel = 0xffffffff;
  await assert.rejects(
    bridge.request("invoke", {
      command: "stream",
      args: { channel: "__CHANNEL__:11" },
    }),
    /exhausted/,
  );
  assert.equal(calls.length, 0);
});
