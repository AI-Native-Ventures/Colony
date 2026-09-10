import assert from "node:assert/strict";
import test from "node:test";

const { resolveTerminalKey } = await import("./terminalKeys.ts");

function makeEvent(overrides = {}) {
  return {
    metaKey: false,
    ctrlKey: false,
    key: "",
    shiftKey: false,
    ...overrides,
  };
}

test("mac with selection and Cmd+C returns copy", () => {
  assert.equal(
    resolveTerminalKey(makeEvent({ metaKey: true, key: "c" }), {
      hasSelection: true,
      platform: "mac",
    }),
    "copy",
  );
});

test("mac without selection and Cmd+C returns pass", () => {
  assert.equal(
    resolveTerminalKey(makeEvent({ metaKey: true, key: "c" }), {
      hasSelection: false,
      platform: "mac",
    }),
    "pass",
  );
});

test("non-mac with selection and Ctrl+C returns copy", () => {
  assert.equal(
    resolveTerminalKey(makeEvent({ ctrlKey: true, key: "c" }), {
      hasSelection: true,
      platform: "other",
    }),
    "copy",
  );
});

test("non-mac without selection and Ctrl+C returns pass", () => {
  assert.equal(
    resolveTerminalKey(makeEvent({ ctrlKey: true, key: "c" }), {
      hasSelection: false,
      platform: "other",
    }),
    "pass",
  );
});

test("Cmd+V returns paste on mac", () => {
  assert.equal(
    resolveTerminalKey(makeEvent({ metaKey: true, key: "v" }), {
      hasSelection: false,
      platform: "mac",
    }),
    "paste",
  );
});

test("Ctrl+V returns paste on other", () => {
  assert.equal(
    resolveTerminalKey(makeEvent({ ctrlKey: true, key: "v" }), {
      hasSelection: false,
      platform: "other",
    }),
    "paste",
  );
});

test("Cmd+F returns search", () => {
  assert.equal(
    resolveTerminalKey(makeEvent({ metaKey: true, key: "f" }), {
      hasSelection: false,
      platform: "mac",
    }),
    "search",
  );
});

test("Cmd+K returns clear", () => {
  assert.equal(
    resolveTerminalKey(makeEvent({ metaKey: true, key: "k" }), {
      hasSelection: false,
      platform: "mac",
    }),
    "clear",
  );
});

test("everything else returns pass", () => {
  assert.equal(
    resolveTerminalKey(makeEvent({ metaKey: true, key: "x" }), {
      hasSelection: false,
      platform: "mac",
    }),
    "pass",
  );
  assert.equal(
    resolveTerminalKey(makeEvent({ ctrlKey: true, key: "x" }), {
      hasSelection: false,
      platform: "other",
    }),
    "pass",
  );
  assert.equal(
    resolveTerminalKey(makeEvent({ key: "Enter" }), {
      hasSelection: false,
      platform: "other",
    }),
    "pass",
  );
});
