import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentTitleForTask,
  carriesRawMessageTitle,
  titleFromSummary,
} from "./agentTaskTitle.ts";

const RAW =
  "@Chief of Staff **find out and let me know about the latest openclaw changes**";
const INSTRUCTION =
  "@Chief of Staff find out and let me know about the latest openclaw changes";

test("a chat task still carrying its message is renameable", () => {
  assert.equal(
    carriesRawMessageTitle({ implicit: true, title: RAW }, INSTRUCTION),
    true,
  );
});

test("a task the owner named by hand is never touched", () => {
  assert.equal(
    carriesRawMessageTitle(
      { implicit: false, title: "Ship the pricing page" },
      INSTRUCTION,
    ),
    false,
  );
});

test("a task the agent already renamed is not renamed again", () => {
  assert.equal(
    carriesRawMessageTitle(
      { implicit: true, title: "Summarise recent OpenClaw releases" },
      INSTRUCTION,
    ),
    false,
  );
});

test("a summary that reads as a name is taken", () => {
  assert.equal(
    titleFromSummary("Summarise recent OpenClaw releases"),
    "Summarise recent OpenClaw releases",
  );
});

test("markdown and extra whitespace are cleaned out of the summary", () => {
  assert.equal(
    titleFromSummary("  **Summarise**   recent   releases  "),
    "Summarise recent releases",
  );
});

test("only the first line is considered", () => {
  assert.equal(
    titleFromSummary("Summarise releases\nthen post the digest to #general"),
    "Summarise releases",
  );
});

test("prose is refused rather than truncated into a title", () => {
  const prose =
    "I read the release notes and then went through each of the linked pull requests to work out what actually changed for users";
  assert.equal(titleFromSummary(prose), null);
});

test("an empty or whitespace summary is refused", () => {
  assert.equal(titleFromSummary(""), null);
  assert.equal(titleFromSummary("   \n  "), null);
  assert.equal(titleFromSummary(null), null);
});

test("the whole decision: agent names a chat task", () => {
  assert.equal(
    agentTitleForTask({
      task: { implicit: true, title: RAW },
      instruction: INSTRUCTION,
      checkpointSummary: "Summarise recent OpenClaw releases",
    }),
    "Summarise recent OpenClaw releases",
  );
});

test("no checkpoint yet leaves the task alone", () => {
  assert.equal(
    agentTitleForTask({
      task: { implicit: true, title: RAW },
      instruction: INSTRUCTION,
      checkpointSummary: null,
    }),
    null,
  );
});

test("a summary equal to the current title is not a rename", () => {
  assert.equal(
    agentTitleForTask({
      task: { implicit: true, title: "Check releases" },
      instruction: "Check releases",
      checkpointSummary: "Check releases",
    }),
    null,
  );
});

test("a hand-created task is never renamed even with a good summary", () => {
  assert.equal(
    agentTitleForTask({
      task: { implicit: false, title: "Ship the pricing page" },
      instruction: "Ship the pricing page",
      checkpointSummary: "Rewrite the pricing copy",
    }),
    null,
  );
});
