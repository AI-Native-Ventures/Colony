import assert from "node:assert/strict";
import test from "node:test";

import { setNativeBridge } from "@/shared/api/nativeBridge";
import { createMockNativeBridge } from "@/testing/createMockNativeBridge";

// revealDesktopAppWindow and listenForDesktopNotificationActions cross the
// native boundary through Colony's NativeBridge seam — install a mock bridge
// before the module loads. block/buzz#3509: a macOS notification click must
// always route, even when a window invoke hangs or the native activation emit
// is lost.

let pendingActivations = [];
let hangWindowInvokes = false;

const hangingInvoke = () => new Promise(() => {});

const mockBridge = createMockNativeBridge((command) => {
  if (command === "take_pending_activations") {
    const drained = pendingActivations;
    pendingActivations = [];
    return Promise.resolve(drained);
  }
  return Promise.resolve(undefined);
});

setNativeBridge({
  ...mockBridge,
  isTauri: () => true,
  unminimize: () => (hangWindowInvokes ? hangingInvoke() : Promise.resolve()),
  showWindow: () => (hangWindowInvokes ? hangingInvoke() : Promise.resolve()),
  setFocus: () => (hangWindowInvokes ? hangingInvoke() : Promise.resolve()),
});

const testWindow = new EventTarget();
// The module under test only checks that a Notification API exists and reads
// its static permission; a plain function stub keeps biome happy.
function StubNotification() {}
StubNotification.permission = "granted";
testWindow.Notification = StubNotification;
globalThis.window = testWindow;
globalThis.document = new EventTarget();
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { platform: "MacIntel", userAgent: "colony-test" },
});

const { listenForDesktopNotificationActions, revealDesktopAppWindow } =
  await import("./desktop.ts");

function flushPendingWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("reveal resolves via timeout when a window invoke hangs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  hangWindowInvokes = true;
  t.after(() => {
    hangWindowInvokes = false;
  });

  let settled = false;
  const reveal = revealDesktopAppWindow().then(() => {
    settled = true;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);

  t.mock.timers.tick(1_500);
  await reveal;
  assert.equal(settled, true);
});

test("reveal resolves without the timer when the invoke chain settles", async (t) => {
  // Mocked timers never fire on their own here, so this await only returns
  // if the helper resolves through the settled invoke chain.
  t.mock.timers.enable({ apis: ["setTimeout"] });

  await revealDesktopAppWindow();
});

test("window focus re-drains activations stranded by a lost emit", async () => {
  const received = [];
  const dispose = await listenForDesktopNotificationActions((target) => {
    received.push(target);
  });

  // The Tauri emit was lost, but the Rust queue still holds the clicked
  // target. macOS foregrounds the app anyway; WebKit fires window focus.
  pendingActivations = [
    { channelId: "channel-1", eventId: "event-1", kind: 9 },
  ];
  window.dispatchEvent(new Event("focus"));
  await flushPendingWork();

  assert.deepEqual(received, [
    {
      channelId: "channel-1",
      channelName: null,
      content: undefined,
      createdAt: null,
      eventId: "event-1",
      kind: 9,
      pubkey: undefined,
      threadRootId: null,
    },
  ]);

  dispose();
  pendingActivations = [
    { channelId: "channel-2", eventId: "event-2", kind: 9 },
  ];
  window.dispatchEvent(new Event("focus"));
  await flushPendingWork();
  assert.equal(received.length, 1, "disposed listener must not re-drain");
  // Leave the queue empty so the next test's mount-time drain starts clean.
  pendingActivations = [];
});

test("visibilitychange re-drains activations stranded by a lost emit", async () => {
  const received = [];
  const dispose = await listenForDesktopNotificationActions((target) => {
    received.push(target);
  });

  pendingActivations = [
    { channelId: "channel-3", eventId: "event-3", kind: 9 },
  ];
  document.dispatchEvent(new Event("visibilitychange"));
  await flushPendingWork();

  assert.equal(received.length, 1);
  assert.equal(received[0].channelId, "channel-3");
  dispose();
});
