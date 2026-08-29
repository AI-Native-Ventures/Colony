import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ASK_WINDOW_SECS,
  MAX_ASK_WINDOW_SECS,
  computeAskDeadline,
} from "./askDeadline.ts";

test("uses the ask's own default_window_secs when it is set", () => {
  const ask = { createdAt: 1_000, defaultWindowSecs: 120 };
  assert.equal(computeAskDeadline(ask, 9_999), 1_120);
});

test("falls back to the community's ask_window_secs when the ask has none", () => {
  const ask = { createdAt: 1_000, defaultWindowSecs: null };
  assert.equal(computeAskDeadline(ask, 7_200), 1_000 + 7_200);
});

test("falls back to DEFAULT_ASK_WINDOW_SECS when neither the ask nor the community names a window", () => {
  const ask = { createdAt: 1_000, defaultWindowSecs: null };
  assert.equal(computeAskDeadline(ask, null), 1_000 + DEFAULT_ASK_WINDOW_SECS);
});

test("clamps a huge community window at MAX_ASK_WINDOW_SECS", () => {
  // The ask's own `default_window_secs` is already bounded at parse time
  // (`parse_ask`'s `DefaultWindowSecsOutOfRange`), but the community default
  // is a different, relay/owner-authored event never run through that
  // validation — the broker's defense-in-depth clamp applies to it, so this
  // must too.
  const ask = { createdAt: 1_000, defaultWindowSecs: null };
  const hugeCompanyWindow = MAX_ASK_WINDOW_SECS * 10;
  assert.equal(
    computeAskDeadline(ask, hugeCompanyWindow),
    1_000 + MAX_ASK_WINDOW_SECS,
  );
});

test("MAX_ASK_WINDOW_SECS is 30 days, matching buzz_core::interrupt", () => {
  assert.equal(MAX_ASK_WINDOW_SECS, 30 * 24 * 60 * 60);
});
