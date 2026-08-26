import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveAnchoredBottomReport,
  resolveSemanticBottomTransition,
  shouldReleaseWithheldTail,
} from "./semanticBottomTransition.ts";

const atBottomState = {
  hasConfirmedBottom: true,
  suppressNext: false,
  semanticAtBottom: true,
};

test("a reader scrolling up freezes the tail and arms the freeze echo guard", () => {
  const transition = resolveSemanticBottomTransition(atBottomState, {
    atBottom: false,
    reason: "scroll",
  });
  assert.equal(transition.commit, false);
  assert.equal(transition.next.semanticAtBottom, false);
  assert.equal(transition.next.suppressNext, true);
  assert.equal(transition.cancelBottomIntent, true);
});

test("the freeze's own at-bottom echo is swallowed, not treated as a return", () => {
  const frozen = {
    hasConfirmedBottom: true,
    suppressNext: true,
    semanticAtBottom: false,
  };
  const transition = resolveSemanticBottomTransition(frozen, {
    atBottom: true,
    reason: "scroll",
  });
  assert.equal(transition.commit, null);
  assert.equal(transition.next.suppressNext, false);
});

test("a resize never freezes the tail: geometry moved, the reader did not", () => {
  const transition = resolveSemanticBottomTransition(atBottomState, {
    atBottom: false,
    reason: "resize",
  });
  assert.equal(transition.commit, null);
  assert.equal(transition.next.semanticAtBottom, true);
  assert.equal(transition.next.suppressNext, false);
});

// The regression this file exists for. Before the fix the armed guard also
// swallowed the resize report, so the tail stayed frozen at the bottom with no
// pill to release it and a just-sent message never rendered.
test("a resize that lands at the bottom releases a frozen tail even with the guard armed", () => {
  const frozenWithGuard = {
    hasConfirmedBottom: true,
    suppressNext: true,
    semanticAtBottom: false,
  };
  const transition = resolveSemanticBottomTransition(frozenWithGuard, {
    atBottom: true,
    reason: "resize",
  });
  assert.equal(transition.commit, true);
  assert.equal(transition.next.semanticAtBottom, true);
  assert.equal(transition.next.suppressNext, false);
});

test("an at-bottom report before any confirmed bottom still confirms it", () => {
  const fresh = {
    hasConfirmedBottom: false,
    suppressNext: false,
    semanticAtBottom: false,
  };
  const transition = resolveSemanticBottomTransition(fresh, {
    atBottom: true,
    reason: "scroll",
  });
  assert.equal(transition.next.hasConfirmedBottom, true);
  assert.equal(transition.commit, true);
});

test("a mount-transient non-bottom before any confirmed bottom does not freeze", () => {
  const fresh = {
    hasConfirmedBottom: false,
    suppressNext: false,
    semanticAtBottom: true,
  };
  const transition = resolveSemanticBottomTransition(fresh, {
    atBottom: false,
    reason: "scroll",
  });
  assert.equal(transition.commit, null);
  assert.equal(transition.next.semanticAtBottom, true);
  assert.equal(transition.cancelBottomIntent, false);
});

// A tail can freeze with nobody having scrolled (an append's re-measure
// reports a non-bottom offset, and the freeze's own at-bottom echo is
// swallowed), leaving withheld output at a scroller already on the floor. CI
// showed that state on 2026-08-18: a "6 new messages" pill with the six rows
// it counted absent from the DOM.
test("withheld output at the bottom releases the tail", () => {
  assert.equal(
    shouldReleaseWithheldTail({
      distanceFromBottom: 0,
      pendingCount: 6,
      semanticAtBottom: false,
    }),
    true,
  );
});

test("a reader who scrolled up keeps their freeze", () => {
  assert.equal(
    shouldReleaseWithheldTail({
      distanceFromBottom: 900,
      pendingCount: 6,
      semanticAtBottom: false,
    }),
    false,
  );
});

test("nothing withheld is nothing to release", () => {
  assert.equal(
    shouldReleaseWithheldTail({
      distanceFromBottom: 0,
      pendingCount: 0,
      semanticAtBottom: false,
    }),
    false,
  );
});

test("an unmounted scroller proves nothing, so it releases nothing", () => {
  assert.equal(
    shouldReleaseWithheldTail({
      distanceFromBottom: null,
      pendingCount: 6,
      semanticAtBottom: false,
    }),
    false,
  );
});

// The anchored-scroll bottom flag is what the "jump to latest" pill renders
// from. Before the fix, resize reports were dropped before reaching it, so a
// mid-resize non-bottom `"scroll"` report could latch it false with nothing
// left to correct it. CI run 32851211991, Desktop E2E Integration shard 2:
// stream.spec.ts measured distanceFromBottom < 8 while
// `message-scroll-to-latest` stayed mounted for all 34 polls of a 15s
// assertion.
test("a resize that lands at the bottom corrects the anchored bottom flag", () => {
  assert.deepEqual(
    resolveAnchoredBottomReport({ atBottom: true, reason: "resize" }),
    { apply: true, readerCaughtUp: false },
  );
});

test("a resize never reports the reader off the bottom", () => {
  assert.deepEqual(
    resolveAnchoredBottomReport({ atBottom: false, reason: "resize" }),
    { apply: false, readerCaughtUp: false },
  );
});

// The reason resize reports were dropped in the first place: the unread pill
// and the "N new messages" count clear on the reader reaching the bottom, and
// geometry moving under a stationary reader is not that.
test("only a scroll to the bottom counts as the reader catching up", () => {
  assert.deepEqual(
    resolveAnchoredBottomReport({ atBottom: true, reason: "scroll" }),
    { apply: true, readerCaughtUp: true },
  );
});

test("a reader scrolling away from the bottom still reports it", () => {
  assert.deepEqual(
    resolveAnchoredBottomReport({ atBottom: false, reason: "scroll" }),
    { apply: true, readerCaughtUp: false },
  );
});
