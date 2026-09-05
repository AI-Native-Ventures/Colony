import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWorkContextAttacher,
  sendIdentity,
  threadAttachMode,
} from "./attachWorkContext.ts";

const AGENT = "b".repeat(64);
const THREAD_ROOT = "5910f909".padEnd(64, "a");
const WORK = "please cut the release video";
const CHAT = "are you there?";

function attacher({ company = { ok: true, value: {} } } = {}) {
  const calls = [];
  const attach = createWorkContextAttacher({
    activeCompany: async () => company,
    resolve: async (request) => {
      calls.push(request);
      return {
        taskId: "thread-task:one",
        initiativeId: null,
        owningTeamId: "team",
        hidden: false,
        tags: [
          ["task", "thread-task:one"],
          ["team", "team"],
        ],
      };
    },
  });
  return { attach, calls };
}

function input(overrides = {}) {
  return {
    channelId: "engineering",
    content: WORK,
    agentPubkeys: [AGENT],
    outgoingTags: [["h", "engineering"]],
    ...overrides,
  };
}

// The first work-implying message opens the thread's task; the relay decides
// whether that means creating one or joining the one already open.
test("a work-implying message asks to open", () => {
  assert.equal(threadAttachMode({ content: WORK }), "open");
});

// "are you there?" is a message, not work. It still charges: the relay puts
// it on the thread's open task, or on the hidden chat task when there is
// none, so no turn goes unattributed and no greeting reaches the Tasks page.
test("a message that implies no work asks to attach", () => {
  assert.equal(threadAttachMode({ content: CHAT }), "attach");
});

// The switch is a member saying "this one is separate". Reading their
// instruction to second-guess it would make the control unreliable exactly
// when it is used deliberately.
test("the composer switch wins over what the message reads like", () => {
  assert.equal(threadAttachMode({ content: CHAT, newTask: true }), "new");
  assert.equal(threadAttachMode({ content: WORK, newTask: true }), "new");
});

test("a reply in a thread carries its root and the DM flag stays off", async () => {
  const { attach, calls } = attacher();
  await attach(input({ threadRoot: THREAD_ROOT }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadRoot, THREAD_ROOT);
  assert.equal(calls[0].conversationScope, false);
  assert.equal(calls[0].mode, "open");
});

test("a send at channel root carries no thread root", async () => {
  const { attach, calls } = attacher();
  await attach(input());
  assert.equal(calls[0].threadRoot, null);
});

test("a DM asks for conversation scope", async () => {
  const { attach, calls } = attacher();
  await attach(input({ conversationScope: true }));
  assert.equal(calls[0].conversationScope, true);
});

// Once a thread holds work, every later message in it belongs to that work
// whether or not it names anybody.
test("a message naming no agent still attaches inside open work", async () => {
  const { attach, calls } = attacher();
  const tags = await attach(
    input({ agentPubkeys: [], content: CHAT, threadHasOpenTask: true }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentPubkey, null);
  assert.equal(calls[0].mode, "attach");
  assert.deepEqual(tags, [
    ["h", "engineering"],
    ["task", "thread-task:one"],
    ["team", "team"],
  ]);
});

// Nobody is being asked for anything and nothing is under way, so there is no
// turn to charge. Opening a hidden task here would record two people talking
// as company cost.
test("a message naming no agent with no open work attaches nothing", async () => {
  const { attach, calls } = attacher();
  const tags = await attach(input({ agentPubkeys: [], content: CHAT }));
  assert.equal(calls.length, 0);
  assert.deepEqual(tags, [["h", "engineering"]]);
});

// Every install that has not been through onboarding. Refusing to send would
// break chat to record accounting nobody asked for yet.
test("a community with no company sends unchanged", async () => {
  const { attach, calls } = attacher({
    company: { ok: false, code: "missing-head", message: "no company" },
  });
  const tags = await attach(input());
  assert.equal(calls.length, 0);
  assert.deepEqual(tags, [["h", "engineering"]]);
});

// A retry has to ask for the same send rather than open a second task.
test("the same instruction to the same agent is the same send", () => {
  assert.equal(
    sendIdentity("engineering", WORK, AGENT),
    sendIdentity("engineering", WORK, AGENT),
  );
  assert.notEqual(
    sendIdentity("engineering", WORK, AGENT),
    sendIdentity("engineering", "something else", AGENT),
  );
});
