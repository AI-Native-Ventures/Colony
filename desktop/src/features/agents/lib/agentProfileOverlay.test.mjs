import assert from "node:assert/strict";
import test from "node:test";

import { resolveChannelDisplayLabel } from "../../sidebar/lib/channelLabels.ts";
import { overlayAgentNamesOntoProfiles } from "./agentProfileOverlay.ts";

const ME = "a".repeat(64);
const AGENT =
  "0e74f2eaeb629ba93662e2b22550989cd2e8d88d6fde5c4d632ff2db79931058";

const AGENT_DM = {
  channelType: "dm",
  name: AGENT,
  participantPubkeys: [ME, AGENT],
  participants: [],
};

const MANAGED_AGENT = {
  pubkey: AGENT,
  name: "Chief of Staff",
  avatarUrl: "data:image/png;base64,planet",
};

test("agent DM with no relay profile resolves the registry name", () => {
  // The regression this guards: the relay has no kind:0 for the agent (its
  // profile publish lagged or failed), so the users-batch lookup is empty.
  // Without the overlay the header and sidebar printed the truncated pubkey.
  const bare = resolveChannelDisplayLabel(AGENT_DM, ME, {});
  assert.equal(bare, `${AGENT.slice(0, 8)}…${AGENT.slice(-4)}`);

  const overlaid = overlayAgentNamesOntoProfiles({}, [MANAGED_AGENT], [], ME);
  assert.equal(
    resolveChannelDisplayLabel(AGENT_DM, ME, overlaid),
    "Chief of Staff",
  );
});

test("overlay fills avatar and agent flag from the managed registry", () => {
  const overlaid = overlayAgentNamesOntoProfiles(
    undefined,
    [MANAGED_AGENT],
    [],
    ME,
  );
  assert.equal(overlaid[AGENT].avatarUrl, "data:image/png;base64,planet");
  assert.equal(overlaid[AGENT].isAgent, true);
  assert.equal(overlaid[AGENT].ownerPubkey, ME);
});

test("relay profile name wins over the registry name", () => {
  const overlaid = overlayAgentNamesOntoProfiles(
    { [AGENT]: { displayName: "Relay Name", avatarUrl: null } },
    [MANAGED_AGENT],
    [],
    ME,
  );
  assert.equal(overlaid[AGENT].displayName, "Relay Name");
});

test("relay agents overlay names too", () => {
  const overlaid = overlayAgentNamesOntoProfiles(
    {},
    [],
    [{ pubkey: AGENT, name: "Relay Agent" }],
    ME,
  );
  assert.equal(overlaid[AGENT].displayName, "Relay Agent");
  assert.equal(overlaid[AGENT].isAgent, true);
});

test("no agents returns the input lookup unchanged, same reference", () => {
  const profiles = { [ME]: { displayName: "Basheer", avatarUrl: null } };
  assert.equal(overlayAgentNamesOntoProfiles(profiles, [], [], ME), profiles);
  assert.equal(
    overlayAgentNamesOntoProfiles(undefined, undefined, undefined, ME),
    undefined,
  );
});
