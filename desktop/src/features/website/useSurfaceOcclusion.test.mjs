import assert from "node:assert/strict";
import test from "node:test";

import { isSurfaceOccluded } from "./useSurfaceOcclusion.ts";

function withDocument(overrides, run) {
  const previous = globalThis.document;
  globalThis.document = {
    hidden: false,
    visibilityState: "visible",
    querySelectorAll: () => [],
    ...overrides,
  };
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previous;
    }
  }
}

test("a hidden document occludes the native surface", () => {
  withDocument({ hidden: true }, () => {
    assert.equal(isSurfaceOccluded(), true);
  });
  withDocument({ visibilityState: "hidden" }, () => {
    assert.equal(isSurfaceOccluded(), true);
  });
});

test("no overlay means no occlusion", () => {
  withDocument({}, () => {
    assert.equal(isSurfaceOccluded(), false);
  });
});

test("any dialog, open menu, or popover occludes", () => {
  withDocument({ querySelectorAll: () => [{}] }, () => {
    assert.equal(isSurfaceOccluded(), true);
  });
});

test("only the exact own dialog node is exempt", () => {
  const ownDialog = {};
  withDocument({ querySelectorAll: () => [ownDialog] }, () => {
    assert.equal(isSurfaceOccluded(ownDialog), false);
  });
});

test("a nested overlay inside the expanded dialog still occludes", () => {
  const ownDialog = {};
  const nestedMenu = { parent: ownDialog };
  withDocument({ querySelectorAll: () => [nestedMenu] }, () => {
    assert.equal(
      isSurfaceOccluded(ownDialog),
      true,
      "a menu inside the dialog paints above it and must hide native content",
    );
  });
});

test("a sibling dialog is never exempted by another dialog's node", () => {
  const ownDialog = {};
  const siblingDialog = {};
  withDocument({ querySelectorAll: () => [siblingDialog] }, () => {
    assert.equal(isSurfaceOccluded(ownDialog), true);
  });
});
