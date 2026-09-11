import test from "node:test";
import assert from "node:assert/strict";
import {
  ALREADY_RAN,
  executeOutreachSend,
  MALFORMED,
  NO_SHARED_TAB,
  NOT_GMAIL,
  WORKER_HELD,
} from "./outreach-send.mjs";
import {
  MAIL_SEND_DISABLED,
  MAIL_SEND_ENV,
  mailSendEnabledFromEnv,
} from "./mail-journey.mjs";

const INSTANCE = "a".repeat(64);
const ACTION = "b".repeat(64);
const GMAIL = "https://mail.google.com/mail/u/0/#inbox";

const approval = (overrides = {}) => ({
  instanceEventId: INSTANCE,
  actionEventId: ACTION,
  data: {
    destination: "lead@example.com",
    content: { subject: "Winter boiler special", body: "Our special is live." },
  },
  ...overrides,
});

/** Shell dependencies with a recording `send`, so no page is needed. */
function deps({ tabs = [{ id: "web", url: GMAIL }], result, fail } = {}) {
  const calls = [];
  return {
    calls,
    attempted: new Set(),
    tabs: () => tabs,
    send: async (input) => {
      calls.push(input);
      if (fail) throw new Error("tab closed");
      return (
        result ?? {
          status: "sent",
          failure_reason: null,
          sent_at: 1_757_000_000,
          to: input.to,
          subject: input.subject,
          screenshot_png_base64: "UE5H",
        }
      );
    },
  };
}

test("an approved card sends and answers in the shape both shells share", async () => {
  const shell = deps();
  const outcome = await executeOutreachSend(approval(), shell);
  assert.deepEqual(outcome, {
    status: "sent",
    sent_at: 1_757_000_000,
    to: "lead@example.com",
    subject: "Winter boiler special",
  });
  assert.deepEqual(shell.calls, [
    {
      tabId: "web",
      to: "lead@example.com",
      subject: "Winter boiler special",
      body: "Our special is live.",
    },
  ]);
});

test("a malformed approval is refused before any tab is touched", async () => {
  const cases = [
    undefined,
    approval({ instanceEventId: "a".repeat(63) }),
    approval({ actionEventId: `z${"b".repeat(63)}` }),
    approval({ data: { content: { subject: "s", body: "b" } } }),
    approval({
      data: {
        destination: "",
        content: { subject: "s", body: "b" },
      },
    }),
    approval({
      data: {
        destination: "lead@example.com",
        content: { subject: "", body: "b" },
      },
    }),
    approval({
      data: {
        destination: "lead@example.com",
        content: { subject: "s", body: "" },
      },
    }),
  ];
  for (const args of cases) {
    const shell = deps();
    assert.deepEqual(
      await executeOutreachSend(args, shell),
      { status: "failed", failure_reason: MALFORMED },
      `expected ${JSON.stringify(args)} to be refused as malformed`,
    );
    assert.equal(shell.calls.length, 0, "a malformed approval must not send");
  }
});

test("no open Web tab tells the owner to open Gmail", async () => {
  const shell = deps({ tabs: [] });
  assert.deepEqual(await executeOutreachSend(approval(), shell), {
    status: "failed",
    failure_reason: NO_SHARED_TAB,
  });
  assert.equal(shell.calls.length, 0);
});

test("a tab on another site is refused by host", async () => {
  for (const url of [
    "https://example.com/mail.google.com",
    "https://mail.google.com.evil.example/inbox",
    "about:blank",
  ]) {
    const shell = deps({ tabs: [{ id: "web", url }] });
    assert.deepEqual(
      await executeOutreachSend(approval(), shell),
      { status: "failed", failure_reason: NOT_GMAIL },
      `expected ${url} to be refused as not Gmail`,
    );
    assert.equal(shell.calls.length, 0);
  }
});

test("a Gmail tab a teammate is driving is left alone", async () => {
  const shell = deps({
    tabs: [
      { id: "news", url: "https://news.example/story" },
      { id: "web", url: GMAIL, controlled: true },
    ],
  });
  assert.deepEqual(await executeOutreachSend(approval(), shell), {
    status: "failed",
    failure_reason: WORKER_HELD,
  });
  assert.equal(shell.calls.length, 0, "the teammate's grant must not be taken");
});

test("the first Gmail tab in open order sends, since one business is one mailbox", async () => {
  const shell = deps({
    tabs: [
      { id: "news", url: "https://news.example/story" },
      { id: "first", url: GMAIL },
      { id: "second", url: "https://mail.google.com/mail/u/0/#sent" },
    ],
  });
  const outcome = await executeOutreachSend(approval(), shell);
  assert.equal(outcome.status, "sent");
  assert.equal(shell.calls[0].tabId, "first");
});

test("allowedHosts lets the mail proof drive its own fixture host", async () => {
  const shell = {
    ...deps({ tabs: [{ id: "web", url: "http://127.0.0.1:4321/gmail.html" }] }),
    allowedHosts: ["127.0.0.1:4321"],
  };
  assert.equal((await executeOutreachSend(approval(), shell)).status, "sent");
  const strict = deps({
    tabs: [{ id: "web", url: "http://127.0.0.1:4321/gmail.html" }],
  });
  assert.equal(
    (await executeOutreachSend(approval(), strict)).failure_reason,
    NOT_GMAIL,
    "the default host list stays Gmail only",
  );
});

test("an approval runs at most once, even after it failed", async () => {
  const shell = deps({
    result: { status: "failed", failure_reason: "compose click failed" },
  });
  assert.deepEqual(await executeOutreachSend(approval(), shell), {
    status: "failed",
    failure_reason: "compose click failed",
  });
  assert.deepEqual(await executeOutreachSend(approval(), shell), {
    status: "failed",
    failure_reason: ALREADY_RAN,
  });
  assert.equal(
    shell.calls.length,
    1,
    "a replay must never fill the form again",
  );
  const other = approval({ actionEventId: "c".repeat(64) });
  assert.equal(
    (await executeOutreachSend(other, shell)).failure_reason,
    "compose click failed",
    "a different approval is a different send, and reaches the journey",
  );
  assert.equal(shell.calls.length, 2);
});

test("a journey that cannot start reads as a missing tab, and stays claimed", async () => {
  const shell = deps({ fail: true });
  assert.deepEqual(await executeOutreachSend(approval(), shell), {
    status: "failed",
    failure_reason: NO_SHARED_TAB,
  });
  assert.deepEqual(await executeOutreachSend(approval(), shell), {
    status: "failed",
    failure_reason: ALREADY_RAN,
  });
});

test("a journey with no reason still gives the owner one", async () => {
  const shell = deps({ result: { status: "failed" } });
  assert.deepEqual(await executeOutreachSend(approval(), shell), {
    status: "failed",
    failure_reason: "Gmail did not confirm the send.",
  });
});

test("the agent-facing mail_send tool is gated on an exact environment value", () => {
  assert.equal(mailSendEnabledFromEnv({}), false);
  for (const value of ["1", "true", "Enabled", "enabled "])
    assert.equal(
      mailSendEnabledFromEnv({ [MAIL_SEND_ENV]: value }),
      false,
      `expected ${JSON.stringify(value)} to leave mail_send disabled`,
    );
  assert.equal(mailSendEnabledFromEnv({ [MAIL_SEND_ENV]: "enabled" }), true);
  assert.match(MAIL_SEND_DISABLED, /^mail_send is disabled: /);
});
