import assert from "node:assert/strict";
import test from "node:test";
import { readFixtureShellResult } from "./tool-result.mjs";

const result = (id, stdout, overrides = {}) => ({
  role: "tool",
  tool_call_id: id,
  content: JSON.stringify({
    exit_code: 0,
    timed_out: false,
    stdout: JSON.stringify(stdout),
    stderr: "",
    ...overrides,
  }),
});

test("reads actual MCP shell wrapper before checking CLI acceptance", () => {
  const read = readFixtureShellResult(
    [result("current", { accepted: true, event_id: "a".repeat(64) })],
    "current",
  );
  assert.equal(read.accepted, true);
  assert.equal(read.exitCode, 0);
  assert.equal(read.timedOut, false);
  assert.equal(read.eventId, "a".repeat(64));
});

test("a previous accepted command cannot satisfy the next issued call", () => {
  const read = readFixtureShellResult(
    [
      result("previous", { accepted: true }),
      result("current", { accepted: false }),
    ],
    "current",
  );
  assert.equal(read.accepted, false);
  assert.throws(() =>
    readFixtureShellResult([result("previous", { accepted: true })], "current"),
  );
});

test("preserves actual command failure and timeout despite accepted stdout", () => {
  const read = readFixtureShellResult(
    [result("current", { accepted: true }, { exit_code: 2, timed_out: true })],
    "current",
  );
  assert.equal(read.exitCode, 2);
  assert.equal(read.timedOut, true);
});
