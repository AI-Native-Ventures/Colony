import assert from "node:assert/strict";
import test from "node:test";

import {
  getThreadReadStateAction,
  getThreadReadStateToggleLabel,
} from "./threadReadState.ts";

test("unread threads offer mark read", () => {
  assert.equal(getThreadReadStateToggleLabel(true), "Mark thread as read");
  assert.equal(getThreadReadStateAction(true), "read");
});

test("read threads offer mark unread", () => {
  assert.equal(getThreadReadStateToggleLabel(false), "Mark thread as unread");
  assert.equal(getThreadReadStateAction(false), "unread");
});
