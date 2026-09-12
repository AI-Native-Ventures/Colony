import assert from "node:assert/strict";
import test from "node:test";

import { isAlreadyMemberError } from "./channelAgents.ts";

test("recognizes the exact duplicate-membership response", () => {
  assert.equal(isAlreadyMemberError("Already a member."), true);
  assert.equal(isAlreadyMemberError("  already a member  "), true);
});

test("does not swallow unrelated membership errors", () => {
  assert.equal(isAlreadyMemberError("Membership rejected"), false);
  assert.equal(isAlreadyMemberError("Already a member of another channel."), false);
});
