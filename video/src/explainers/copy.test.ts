import assert from "node:assert/strict";
import { test } from "node:test";
import { copyProblems } from "../launch/copy-scan.test.ts";

test("no banned word or em dash anywhere in the explainers' source", () => {
  assert.deepEqual(copyProblems(new URL(".", import.meta.url)), []);
});
