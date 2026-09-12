import assert from "node:assert/strict";
import test, { mock } from "node:test";

const calls = [];
const addedPubkey = "b".repeat(64);

mock.module("@/shared/api/tauri", {
  namedExports: {
    invokeTauri: async (command, args) => {
      calls.push({ command, args });
      return { added: [addedPubkey], errors: [] };
    },
  },
});

const { addWebsiteTeamMember } = await import("./tauriWebsiteTeam.ts");

test("Website membership adapter sends the captured owner and relay scope", async () => {
  const result = await addWebsiteTeamMember({
    channelId: "channel-1",
    pubkey: addedPubkey,
    role: "bot",
    expectedOwnerPubkey: "a".repeat(64),
    expectedRelayUrl: "wss://relay.example/team",
  });

  assert.deepEqual(result, { added: [addedPubkey], errors: [] });
  assert.deepEqual(calls, [
    {
      command: "add_website_team_member",
      args: {
        channelId: "channel-1",
        pubkey: addedPubkey,
        role: "bot",
        expectedOwnerPubkey: "a".repeat(64),
        expectedRelayUrl: "wss://relay.example/team",
      },
    },
  ]);
});
