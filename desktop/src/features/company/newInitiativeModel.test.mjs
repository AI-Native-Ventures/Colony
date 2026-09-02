import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_INITIATIVE_TITLE_LEN,
  validateNewInitiativeInput,
} from "./newInitiativeModel.ts";

test("title_is_required", () => {
  const result = validateNewInitiativeInput({
    channelId: "channel-1",
    title: "   ",
    summary: "",
    costCentreId: "cc-internal",
  });
  assert.deepEqual(result, {
    ok: false,
    message: "Give this initiative a title.",
  });
});

test("title_is_trimmed", () => {
  const result = validateNewInitiativeInput({
    channelId: "channel-1",
    title: "  Rebuild onboarding  ",
    summary: "  a summary  ",
    costCentreId: "cc-internal",
  });
  assert.equal(result.ok, true);
  assert.equal(result.title, "Rebuild onboarding");
  assert.equal(result.summary, "a summary");
});

test("cost_centre_is_required", () => {
  const result = validateNewInitiativeInput({
    channelId: "channel-1",
    title: "Rebuild onboarding",
    summary: "",
    costCentreId: "",
  });
  assert.deepEqual(result, {
    ok: false,
    message: "Choose a cost centre for this initiative.",
  });
});

test("a channel is required", () => {
  const result = validateNewInitiativeInput({
    channelId: "",
    title: "Rebuild onboarding",
    summary: "",
    costCentreId: "cc-internal",
  });
  assert.deepEqual(result, {
    ok: false,
    message: "Choose a channel for this initiative.",
  });
});

test("a title over the cap is refused", () => {
  const result = validateNewInitiativeInput({
    channelId: "channel-1",
    title: "x".repeat(MAX_INITIATIVE_TITLE_LEN + 1),
    summary: "",
    costCentreId: "cc-internal",
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /too long/i);
});

test("valid_draft_produces_the_request", () => {
  const result = validateNewInitiativeInput({
    channelId: "channel-1",
    title: "Rebuild onboarding",
    summary: "",
    costCentreId: "cc-internal",
  });
  assert.deepEqual(result, {
    ok: true,
    channelId: "channel-1",
    title: "Rebuild onboarding",
    // An empty summary and no summary mean the same thing to the relay, so
    // the form's untouched textarea must not travel as an empty string.
    summary: null,
    costCentreId: "cc-internal",
  });
});
