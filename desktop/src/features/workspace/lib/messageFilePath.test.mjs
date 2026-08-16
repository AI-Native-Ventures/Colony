import assert from "node:assert/strict";
import test from "node:test";

import { parseMessageFilePath } from "./messageFilePath.ts";

test("recognises the paths agents actually write", () => {
  assert.equal(parseMessageFilePath("PLANS/FOO.md"), "PLANS/FOO.md");
  assert.equal(
    parseMessageFilePath("desktop/src/app/App.tsx"),
    "desktop/src/app/App.tsx",
  );
  assert.equal(parseMessageFilePath("./notes/today.md"), "./notes/today.md");
  assert.equal(parseMessageFilePath("  RESEARCH/a.md  "), "RESEARCH/a.md");
});

test("drops a trailing line reference so the path still opens", () => {
  assert.equal(
    parseMessageFilePath("crates/relay/src/lib.rs:42"),
    "crates/relay/src/lib.rs",
  );
});

test("leaves prose, URLs, and mime types alone", () => {
  assert.equal(parseMessageFilePath("text/markdown"), null);
  assert.equal(parseMessageFilePath("application/json"), null);
  assert.equal(parseMessageFilePath("and/or"), null);
  assert.equal(parseMessageFilePath("e.g."), null);
  assert.equal(parseMessageFilePath("node.js"), null);
  assert.equal(parseMessageFilePath("v1.2.3"), null);
  assert.equal(parseMessageFilePath("https://example.com/a.md"), null);
  assert.equal(parseMessageFilePath("file:///tmp/a.md"), null);
  assert.equal(parseMessageFilePath("pnpm test -- a.md"), null);
  assert.equal(parseMessageFilePath(""), null);
  assert.equal(parseMessageFilePath("PLANS/"), null);
});

test("refuses traversal and oversized tokens", () => {
  assert.equal(parseMessageFilePath("../../etc/passwd.txt"), null);
  assert.equal(parseMessageFilePath("PLANS/../../../a.md"), null);
  assert.equal(parseMessageFilePath(`${"a/".repeat(400)}b.md`), null);
});

test("a bare file name is never a path, however file-shaped it looks", () => {
  assert.equal(parseMessageFilePath("AGENTS.md"), null);
  assert.equal(parseMessageFilePath("package.json"), null);
  assert.equal(parseMessageFilePath("out/report.zzz"), "out/report.zzz");
});
