import test from "node:test";
import assert from "node:assert/strict";
import { responseProof } from "./responseProof.ts";
const frame = (kind, payload = {}, turnId = "turn", channelId = "private") => ({
  kind,
  payload,
  turnId,
  channelId,
});
test("requires matching trigger, successful ACP response and completion", () => {
  const p = responseProof("request", "private");
  assert.equal(p.accept(frame("turn_completed")), "waiting");
  assert.equal(
    p.accept(frame("turn_started", { triggeringEventIds: ["old"] })),
    "waiting",
  );
  assert.equal(
    p.accept(frame("acp_read", { result: { stopReason: "end_turn" } })),
    "waiting",
  );
  assert.equal(
    p.accept(frame("turn_started", { triggeringEventIds: ["request"] })),
    "success",
  );
});
test("wrong channel or turn and failed completions cannot pass", () => {
  const p = responseProof("request", "private");
  p.accept(frame("turn_started", { triggeringEventIds: ["request"] }));
  assert.equal(
    p.accept(
      frame("acp_read", { result: { stopReason: "end_turn" } }, "other"),
    ),
    "waiting",
  );
  assert.equal(
    p.accept(
      frame(
        "acp_read",
        { result: { stopReason: "end_turn" } },
        "turn",
        "other",
      ),
    ),
    "waiting",
  );
  assert.equal(p.accept(frame("turn_error")), "failed");
  assert.equal(p.accept(frame("turn_completed")), "failed");
});
test("empty and cancelled completions never pass", () => {
  const p = responseProof("request", "private");
  p.accept(frame("turn_started", { triggeringEventIds: ["request"] }));
  p.accept(frame("acp_read", { result: { stopReason: "cancelled" } }));
  assert.equal(p.accept(frame("turn_completed")), "waiting");
});
