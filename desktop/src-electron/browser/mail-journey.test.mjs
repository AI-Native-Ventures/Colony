import test from "node:test";
import assert from "node:assert/strict";
import { mailSend } from "./mail-journey.mjs";

const node = (backendDOMNodeId, role, name) => ({
  backendDOMNodeId,
  ignored: false,
  role: { value: role },
  name: { value: name },
});

const COMPOSE_ONLY = [node(1, "button", "Compose")];
const FORM = [
  node(1, "button", "Compose"),
  node(2, "combobox", "To recipients"),
  node(3, "textbox", "Subject"),
  node(4, "textbox", "Message Body"),
  node(5, "button", "Send ‎(⌘Enter)"),
];
const SENT = [...FORM, node(6, "alert", "Message sent Undo")];

/**
 * A tab whose CDP debugger serves scripted replies and records every command,
 * so a journey can be proven with no Electron and no real page.
 */
function fakeTab({ stages, form = FORM }) {
  const calls = [];
  const filled = new Map();
  let stage = 0;
  let focused = null;
  const debuggerStub = {
    isAttached: () => true,
    attach() {},
    async sendCommand(method, params) {
      calls.push({ method, params });
      if (method === "Accessibility.getFullAXTree") {
        const nodes = stages[Math.min(stage, stages.length - 1)];
        stage += 1;
        return { nodes };
      }
      if (method === "DOM.resolveNode")
        return { object: { objectId: `object-${params.backendNodeId}` } };
      if (method === "Runtime.callFunctionOn") {
        const backendNodeId = Number(params.objectId.replace("object-", ""));
        if (params.functionDeclaration.includes("this.click()")) {
          if (backendNodeId === 1) stage = stages.length - 2;
          if (backendNodeId === 5) stage = stages.length - 1;
          focused = null;
        } else {
          focused = backendNodeId;
        }
        return {};
      }
      if (method === "Input.insertText") {
        filled.set(focused, params.text);
        return {};
      }
      if (method === "Runtime.releaseObject") return {};
      if (method === "Page.captureScreenshot") return { data: "UE5H" };
      throw new Error(`Unexpected CDP command ${method}`);
    },
  };
  return {
    tab: {
      id: "tab",
      observation: { refs: new Map(), revision: 0 },
      view: { webContents: { debugger: debuggerStub } },
    },
    calls,
    filled,
    form,
  };
}

const fast = {
  waitMs: 300,
  controlPollMs: 5,
  sentPollMs: 5,
  maxSnapshots: 6,
};
const message = {
  to: "lead@example.com",
  subject: "Winter boiler special",
  body: "Hi team, our winter special is live.",
};

test("mail_send clicks Compose, fills the form, sends and reports the contract", async () => {
  const writes = [];
  const { tab, calls, filled } = fakeTab({
    stages: [COMPOSE_ONLY, COMPOSE_ONLY, FORM, SENT],
  });
  const result = await mailSend(
    tab,
    message,
    (options) => writes.push(options?.write === true),
    fast,
  );
  assert.equal(result.status, "sent", result.failure_reason ?? "");
  assert.equal(result.failure_reason, null);
  assert.equal(result.to, message.to);
  assert.equal(result.subject, message.subject);
  assert.equal(result.screenshot_png_base64, "UE5H");
  assert.ok(Number.isInteger(result.sent_at) && result.sent_at > 0);
  assert.deepEqual(
    [filled.get(2), filled.get(3), filled.get(4)],
    [message.to, message.subject, message.body],
  );
  const clicked = calls
    .filter(
      (call) =>
        call.method === "Runtime.callFunctionOn" &&
        call.params.functionDeclaration.includes("this.click()"),
    )
    .map((call) => call.params.objectId);
  assert.deepEqual(
    clicked,
    ["object-1", "object-5"],
    "Compose first, Send last",
  );
  assert.ok(
    !calls.some((call) => call.method.startsWith("Page.navigate")),
    "the journey must never navigate",
  );
  assert.ok(
    writes.some((write) => write === true),
    "writes must pass through the interaction guard",
  );
  assert.equal(tab.observation, null, "stale refs must be dropped");
});

test("mail_send names the missing Send control when the page has none", async () => {
  const withoutSend = FORM.filter((entry) => entry.backendDOMNodeId !== 5);
  const { tab } = fakeTab({
    stages: [COMPOSE_ONLY, withoutSend, withoutSend, withoutSend],
  });
  const result = await mailSend(tab, message, () => {}, fast);
  assert.equal(result.status, "failed");
  assert.equal(
    result.failure_reason,
    "missing send control (expected name starting with 'Send', found: To recipients, Subject, Message Body)",
  );
  assert.equal(result.screenshot_png_base64, null);
});

test("mail_send times out when 'Message sent' never appears, with a screenshot", async () => {
  const { tab } = fakeTab({ stages: [COMPOSE_ONLY, COMPOSE_ONLY, FORM, FORM] });
  const result = await mailSend(tab, message, () => {}, fast);
  assert.equal(result.status, "failed");
  assert.equal(
    result.failure_reason,
    "timeout: 'Message sent' did not appear within 30 s",
  );
  assert.equal(
    result.screenshot_png_base64,
    "UE5H",
    "a timeout must still return evidence",
  );
});

test("mail_send rejects empty and oversized fields before touching the page", async () => {
  const { tab, calls } = fakeTab({ stages: [COMPOSE_ONLY] });
  await assert.rejects(
    mailSend(tab, { ...message, to: "" }, () => {}, fast),
    /Field "to" must be a non-empty string/,
  );
  await assert.rejects(
    mailSend(tab, { ...message, body: "x".repeat(4001) }, () => {}, fast),
    /Field "body" must be at most 4000 characters/,
  );
  assert.deepEqual(calls, []);
});

test("mail_send stops as soon as the grant is revoked", async () => {
  const { tab } = fakeTab({ stages: [COMPOSE_ONLY, FORM, SENT] });
  await assert.rejects(
    mailSend(
      tab,
      message,
      () => {
        throw new Error("Access revoked; ask the owner to share the tab again");
      },
      fast,
    ),
    /Access revoked/,
  );
});
