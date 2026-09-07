import test from "node:test";
import assert from "node:assert/strict";
import { NativeChannel, invoke } from "./nativeBridge.ts";
import { installElectronNativeBridge } from "./electronNativeBridge.ts";
test("native channel deliveries restore sequence order across concurrent Rust sends", async (t) => {
  const old = globalThis.window;
  let push;
  let channelId;
  globalThis.window = {
    colonyDesktop: {
      subscribe(callback) {
        push = callback;
        return () => {};
      },
      async request(_type, payload) {
        channelId = Number(payload.args.channel.split(":")[1]);
        return true;
      },
    },
  };
  t.after(() => {
    globalThis.window = old;
  });
  installElectronNativeBridge();
  const delivered = [];
  const channel = new NativeChannel((value) => delivered.push(value));
  await invoke("fixture", { channel });
  push({ type: "channel", id: channelId, sequence: 1, payload: "second" });
  assert.deepEqual(delivered, []);
  push({ type: "channel", id: channelId, sequence: 0, payload: "first" });
  assert.deepEqual(delivered, ["first", "second"]);
  push({ type: "channel", id: channelId, sequence: 0, payload: "duplicate" });
  assert.equal(delivered.length, 2);
});
