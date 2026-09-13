import assert from "node:assert/strict";
import test from "node:test";

import { FIRST_JOB_SUGGESTION_MARKER } from "../firstJobSuggestion.ts";
import {
  ROOT_PROTOCOL,
  createScoutOnboardingRootPayload,
  parseScoutOnboardingRoot,
  scoutOnboardingRootBody,
  scoutOnboardingRootTags,
} from "./protocol.ts";

const scope = {
  ownerPubkey: "a".repeat(64),
  relayUrl: "wss://example.test",
  channelId: "welcome",
  requestId: "signup-1",
};

test("ROOT_PROTOCOL builds a scoped root and preserves explicit no website", () => {
  const payload = createScoutOnboardingRootPayload(scope, {
    ownerName: "Ari",
    businessName: "Acme",
    businessDescription: "Local service",
    website: "",
    hasWebsite: false,
  });
  const tags = scoutOnboardingRootTags(payload);
  const parsed = parseScoutOnboardingRoot(tags);

  assert.equal(ROOT_PROTOCOL.marker, "colony:scout-onboarding-root:v1");
  assert.equal(tags[1][1], FIRST_JOB_SUGGESTION_MARKER);
  assert.equal(parsed?.seed.websiteState, "none");
  assert.equal(parsed?.seed.website, "");
  assert.match(scoutOnboardingRootBody(payload), /Website: None provided/);
  assert.doesNotMatch(scoutOnboardingRootBody(payload), /First task|Start/);
});

test("the parser fails closed for duplicate or malformed roots", () => {
  const payload = createScoutOnboardingRootPayload(scope, {
    businessName: "Acme",
  });
  const tags = scoutOnboardingRootTags(payload);
  assert.equal(parseScoutOnboardingRoot([...tags, tags[2]]), null);
  assert.equal(
    parseScoutOnboardingRoot(
      tags.map((tag) =>
        tag[1] === ROOT_PROTOCOL.marker ? [tag[0], tag[1], "{}"] : tag,
      ),
    ),
    null,
  );
});

test("website provenance distinguishes unanswered from explicit no website", () => {
  const missing = createScoutOnboardingRootPayload(scope, { website: "" });
  const none = createScoutOnboardingRootPayload(scope, {
    website: "",
    websiteState: "none",
  });
  assert.equal(missing.seed.websiteState, "unknown");
  assert.equal(none.seed.websiteState, "none");
});
