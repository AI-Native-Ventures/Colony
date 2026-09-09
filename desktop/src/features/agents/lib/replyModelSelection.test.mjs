import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acknowledgeReplyModelSelection,
  replyModelOptions,
  replyModelTag,
  restoreReplyModelSelection,
  validateReplyModelRecipient,
} from "./replyModelSelection.ts";
const agent = "aa".repeat(32);
const selection = { targetPubkey: agent, modelId: "model[high]" };
test("a reply pin requires the exact supported model and addressed teammate", () => {
  assert.deepEqual(replyModelTag(selection, [agent], ["model[high]"]), [
    "agent-reply",
    "1",
    agent,
    "model[high]",
  ]);
  assert.throws(
    () => replyModelTag(selection, [agent], ["model[low]"]),
    /unavailable/,
  );
  assert.throws(() => replyModelTag(selection, [], ["model[high]"]), /receive/);
  assert.equal(replyModelTag(null, [], []), undefined);
});
test("send recovery retains the requested pair and preserves a newer draft choice", () => {
  const tag = replyModelTag(selection, [agent], [selection.modelId]);
  const restored = restoreReplyModelSelection(null, tag);
  assert.deepEqual(restored, selection);
  assert.deepEqual(replyModelTag(restored, [agent], [selection.modelId]), tag);
  const newer = { ...selection, modelId: "model[low]" };
  assert.equal(restoreReplyModelSelection(newer, tag), newer);
  assert.equal(restoreReplyModelSelection(null, ["imeta"]), null);
});
test("an older send acknowledgement cannot clear a newer identical choice", () => {
  const sent = { selection, conversation: "channel-a:thread-1" };
  const tag = replyModelTag(selection, [agent], [selection.modelId]);
  const newer = { ...selection };
  assert.equal(
    acknowledgeReplyModelSelection(newer, sent, sent.conversation, tag),
    newer,
  );
  assert.equal(
    acknowledgeReplyModelSelection(selection, sent, sent.conversation, tag),
    null,
  );
});
test("an acknowledgement cannot clear a selection in another conversation", () => {
  const sent = { selection, conversation: "channel-a:thread-1" };
  const tag = replyModelTag(selection, [agent], [selection.modelId]);
  assert.equal(
    acknowledgeReplyModelSelection(selection, sent, "channel-a:thread-2", tag),
    selection,
  );
});
test("model and reasoning axes are decoded from adapter ids only", () => {
  assert.deepEqual(
    replyModelOptions([{ id: "model[unfamiliar-effort]" }, { id: "plain" }]),
    [
      {
        id: "model[unfamiliar-effort]",
        baseId: "model",
        effort: "unfamiliar-effort",
      },
      { id: "plain", baseId: "plain", effort: null },
    ],
  );
});
test("removing a recipient during invite or upload cannot move its pin", () => {
  const tags = [replyModelTag(selection, [agent], ["model[high]"])];
  assert.doesNotThrow(() => validateReplyModelRecipient(tags, [agent]));
  assert.throws(
    () => validateReplyModelRecipient(tags, ["bb".repeat(32)]),
    /removed/,
  );
  assert.doesNotThrow(() => validateReplyModelRecipient([], []));
});
