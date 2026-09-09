import assert from "node:assert/strict";
import { test } from "node:test";
import {
  replyModelOptions,
  replyModelTag,
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
