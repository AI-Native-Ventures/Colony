import assert from "node:assert/strict";
import test from "node:test";

import { nextInstallState } from "./InstallScreen.tsx";

test("install_failure_offers_a_way_forward", () => {
  const failed = nextInstallState("running", { type: "failed" });
  assert.equal(failed, "failed");
  // Never a dead end: retry, or continue into a degraded workspace.
  assert.equal(nextInstallState("failed", { type: "retry" }), "running");
  assert.equal(nextInstallState("failed", { type: "skip" }), "degraded");
});

test("install_success_moves_on", () => {
  assert.equal(nextInstallState("running", { type: "succeeded" }), "done");
});
