/**
 * The send command's tag channels, proven at the invoke boundary.
 *
 * Work-context tags (`["task", ...]`, `["team", ...]`) are attached by the
 * composer to any agent-directed message whose text implies work. They used to
 * ride the imeta-only `mediaTags` argument, where the Rust `imeta_tags` guard
 * rejected the first one and failed the whole send, so the message never
 * posted while the Task it had already created stayed on the relay.
 *
 * These tests drive the same two units the send mutation composes:
 * `splitOutgoingTags` sorts the merged outgoing set into buckets, and
 * `sendChannelMessage` hands each bucket to its own validated Tauri argument.
 *
 * The Tauri mock is installed once at module scope, not per test: a dynamic
 * import is cached, so a second `t.mock.module` for the same specifier would
 * never reach the already-loaded module under test.
 */
import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";

import { splitOutgoingTags } from "@/features/messages/lib/imetaMediaMarkdown";

const CHANNEL_ID = "1f8b7916-3345-499c-995e-14dd8abf7b9b";
const IMETA = ["imeta", "url https://blossom/abc.png", "m image/png"];
const WORK_TASK = ["task", "chat:eecf0442-ac20-5939-a95a-0306f5441260"];
const WORK_TEAM = ["team", "builtin-team:company-coordination"];

/** Every `invoke` the module under test makes, in order. */
const calls = [];

mock.module("@/shared/api/tauri", {
  namedExports: {
    invokeTauri: async (command, args) => {
      calls.push({ command, args });
      return {
        event_id: "a".repeat(64),
        parent_event_id: null,
        root_event_id: null,
        depth: 0,
        created_at: 1_756_800_000,
      };
    },
  },
});

const { sendChannelMessage } = await import("@/shared/api/sendChannelMessage");

beforeEach(() => {
  calls.length = 0;
});

/** The one `send_channel_message` invoke of the call just made. */
function onlyInvokeArgs() {
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "send_channel_message");
  return calls[0].args;
}

test("work tags reach send_channel_message under workTags, not mediaTags", async () => {
  const {
    mediaTags: imetaTags,
    emojiTags,
    mentionTags,
    referenceTags,
    linkPreviewTags,
    workTags,
  } = splitOutgoingTags([IMETA, WORK_TASK, WORK_TEAM]);

  await sendChannelMessage({
    channelId: CHANNEL_ID,
    content: "@Christine - Graphic Designer okay?",
    mediaTags: imetaTags,
    emojiTags,
    mentionTags,
    blockReferenceTags: referenceTags,
    linkPreviewTags,
    workTags,
  });

  const args = onlyInvokeArgs();
  assert.deepEqual(args.workTags, [WORK_TASK, WORK_TEAM]);
  assert.deepEqual(args.mediaTags, [IMETA]);
});

test("a message with no work context sends workTags as null", async () => {
  await sendChannelMessage({
    channelId: CHANNEL_ID,
    content: "no work here",
    mediaTags: [],
  });

  assert.equal(onlyInvokeArgs().workTags, null);
});
