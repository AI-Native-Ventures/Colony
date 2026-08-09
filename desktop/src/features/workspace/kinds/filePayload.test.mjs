import assert from "node:assert/strict";
import test from "node:test";

const { readFilePath, titleForPath } = await import("../lib/filePayload.ts");

test("a payload without a usable path reads as null", () => {
  assert.equal(readFilePath(null), null);
  assert.equal(readFilePath({}), null);
  assert.equal(readFilePath({ path: 42 }), null);
  assert.equal(readFilePath({ path: "   " }), null);
});

test("a payload with a path reads it back trimmed", () => {
  assert.equal(readFilePath({ path: " /a/b.md " }), "/a/b.md");
});

test("the tab title is the file name, not the whole path", () => {
  assert.equal(titleForPath("/Users/x/notes/todo.md"), "todo.md");
  assert.equal(titleForPath("todo.md"), "todo.md");
  assert.equal(titleForPath(""), "Untitled");
});
