import test from "node:test";
import assert from "node:assert/strict";
import {
  assertMailSendEnabled,
  MAIL_SEND_DISABLED,
  MAIL_SEND_ENV,
} from "./mail-journey.mjs";
import { runBrowserTool } from "./tool-dispatch.mjs";

const message = {
  tabId: "tab",
  to: "lead@example.com",
  subject: "Winter boiler special",
  body: "Hi team, our winter special is live.",
};

const node = (backendDOMNodeId, role, name) => ({
  backendDOMNodeId,
  ignored: false,
  role: { value: role },
  name: { value: name },
});

/** A tab whose debugger answers just enough for a snapshot to succeed. */
function fakeTab({ axError } = {}) {
  const calls = [];
  return {
    calls,
    tab: {
      id: "tab",
      observation: null,
      view: {
        webContents: {
          getURL: () => "https://mail.google.com/mail/u/0/#inbox",
          getTitle: () => "Inbox",
          isLoading: () => false,
          debugger: {
            isAttached: () => true,
            attach() {},
            async sendCommand(method) {
              calls.push(method);
              if (method === "Accessibility.getFullAXTree") {
                if (axError) throw new Error("the page went away");
                return { nodes: [node(1, "button", "Compose")] };
              }
              throw new Error(`Unexpected CDP command ${method}`);
            },
          },
        },
      },
    },
  };
}

const check = () => ({ revision: 0 });

test("the shared gate refuses and allows on the exact environment value", () => {
  assert.throws(() => assertMailSendEnabled({}), {
    message: MAIL_SEND_DISABLED,
  });
  assert.throws(() => assertMailSendEnabled({ [MAIL_SEND_ENV]: "true" }), {
    message: MAIL_SEND_DISABLED,
  });
  assert.doesNotThrow(() =>
    assertMailSendEnabled({ [MAIL_SEND_ENV]: "enabled" }),
  );
});

test("a worker reaching the main process directly still cannot send mail", async () => {
  const { tab, calls } = fakeTab();
  await assert.rejects(
    async () => runBrowserTool(tab, "mail_send", message, check, {}),
    { message: MAIL_SEND_DISABLED },
    "an ungated main process must refuse the journey, not only the adapter",
  );
  assert.deepEqual(calls, [], "a refused journey must not touch the page");
});

test("the gate is on mail_send alone: the same grant still reads the page", async () => {
  const { tab, calls } = fakeTab();
  const observed = await runBrowserTool(tab, "browser_snapshot", {}, check, {});
  assert.equal(observed.tabId, "tab");
  assert.match(observed.outline, /button Compose/);
  assert.deepEqual(calls, ["Accessibility.getFullAXTree"]);
});

test("mail_send runs once the main process carries the gate value", async () => {
  // The page fails on the journey's first read, so the call reaches the page
  // and stops there. Reaching it at all is the point: the gate let it run.
  const { tab, calls } = fakeTab({ axError: true });
  await assert.rejects(
    async () =>
      runBrowserTool(tab, "mail_send", message, check, {
        [MAIL_SEND_ENV]: "enabled",
      }),
    { message: "the page went away" },
  );
  assert.deepEqual(calls, ["Accessibility.getFullAXTree"]);
});

test("an unknown tool is refused by name", async () => {
  const { tab } = fakeTab();
  await assert.rejects(
    async () => runBrowserTool(tab, "browser_eval", {}, check, {}),
    { message: "Unknown browser tool" },
  );
});
