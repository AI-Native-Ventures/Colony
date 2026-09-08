import assert from "node:assert/strict";
import test from "node:test";
import { messageExcerpt } from "./messageExcerpt.ts";

const opening = "This is the opening paragraph with the information to review. "
  .repeat(5)
  .trim();
const detail =
  "These are the supporting details that stay available in the original message. "
    .repeat(12)
    .trim();
const content = `**Your update**\n\n${opening}\n\n${detail}`;

test("long prose keeps complete opening paragraphs, without inventing a summary", () => {
  assert.equal(messageExcerpt(content), `**Your update**\n\n${opening}`);
});

test("short messages and one long paragraph stay complete", () => {
  assert.equal(messageExcerpt("Hello there."), null);
  assert.equal(messageExcerpt(detail), null);
});

test("structured markdown and media are never hidden behind the prose disclosure", () => {
  for (const structured of [
    "```ts\nconst result = 1;\n```",
    "![Preview](asset.png)",
    "https://example.test/work",
    "| Day | Work |\n| --- | --- |",
    "- Review the work\n- Reply to the client",
    "> A quotation from the client",
    "1. First step\n2. Second step",
    "<details>Work</details>",
  ]) {
    assert.equal(messageExcerpt(`${content}\n\n${structured}`), null);
  }
});

test("an oversized opening is left complete instead of cut mid-paragraph", () => {
  assert.equal(messageExcerpt(`${detail}\n\n${opening}\n\n${detail}`), null);
});
