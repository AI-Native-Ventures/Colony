import assert from "node:assert/strict";
import test from "node:test";

import {
  clearCommunityStorage,
  initFirstCommunity,
  hasLegacyAutoConnectRecovery,
  loadCommunities,
  loadCommunityDiscoveryAfterLeave,
  markCommunityDiscoveryAfterLeave,
  migrateLegacyCommunityStorage,
  quarantineLegacyAutoConnectedCommunity,
  restoreLegacyAutoConnectedCommunity,
  saveCommunities,
  shouldAutoConnectDefaultRelay,
  shouldRecoverLegacyAutoConnectedCommunity,
} from "./communityStorage.ts";

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };
}

test("migrateLegacyCommunityStorage promotes current Buzz workspace state", () => {
  const storage = createMemoryStorage({
    "buzz-workspaces": '[{"id":"current"}]',
    "buzz-active-workspace-id": "current",
  });

  migrateLegacyCommunityStorage(storage);

  assert.equal(storage.getItem("buzz-communities"), '[{"id":"current"}]');
  assert.equal(storage.getItem("buzz-active-community-id"), "current");
});

test("migrateLegacyCommunityStorage does not overwrite new community state", () => {
  const storage = createMemoryStorage({
    "buzz-communities": '[{"id":"new"}]',
    "buzz-active-community-id": "new",
    "buzz-workspaces": '[{"id":"old"}]',
    "buzz-active-workspace-id": "old",
  });

  migrateLegacyCommunityStorage(storage);

  assert.equal(storage.getItem("buzz-communities"), '[{"id":"new"}]');
  assert.equal(storage.getItem("buzz-active-community-id"), "new");
});

test("loadCommunities repairs legacy scheme-less relay URLs", () => {
  const storage = createMemoryStorage({
    "buzz-communities": JSON.stringify([
      {
        id: "legacy",
        name: "Colony",
        relayUrl: "relay.colony.ainative.ventures",
        nsec: "nsec1-legacy-secret",
      },
    ]),
    "buzz-active-community-id": "legacy",
  });
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage };

  const [community] = loadCommunities();

  assert.equal(community.relayUrl, "wss://relay.colony.ainative.ventures");
  assert.equal("nsec" in community, false);
  assert.deepEqual(JSON.parse(storage.getItem("buzz-communities")), [
    {
      id: "legacy",
      name: "Colony",
      relayUrl: "wss://relay.colony.ainative.ventures",
    },
  ]);
});

test("loadCommunities preserves an already-schemed loopback relay URL", () => {
  const storage = createMemoryStorage({
    "buzz-communities": JSON.stringify([
      { id: "local", name: "Local Dev", relayUrl: "ws://localhost:3000" },
    ]),
  });
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage };

  const [community] = loadCommunities();

  assert.equal(community.relayUrl, "ws://localhost:3000");
  assert.deepEqual(JSON.parse(storage.getItem("buzz-communities")), [
    { id: "local", name: "Local Dev", relayUrl: "ws://localhost:3000" },
  ]);
});

test("signed-build relay defaults auto-connect during first-run onboarding", () => {
  assert.equal(
    shouldAutoConnectDefaultRelay("wss://buzz.block.builderlab.xyz"),
    true,
  );
  assert.equal(shouldAutoConnectDefaultRelay("ws://localhost:3000"), false);
  assert.equal(shouldAutoConnectDefaultRelay("ws://127.0.0.1:3000"), false);
  assert.equal(shouldAutoConnectDefaultRelay("ws://[::1]:3000"), false);
  assert.equal(shouldAutoConnectDefaultRelay("ws://0.0.0.0:3000"), false);
  assert.equal(shouldAutoConnectDefaultRelay("http://localhost:3000"), false);
  assert.equal(
    shouldAutoConnectDefaultRelay("https://relay.example.com"),
    false,
  );
  assert.equal(shouldAutoConnectDefaultRelay("relay.example.com"), false);
  assert.equal(shouldAutoConnectDefaultRelay("not a valid relay"), false);
});

test("legacy default community recovery requires the exact obsolete record shape", () => {
  const defaultRelayUrl = "wss://relay.colony.ainative.ventures";
  const community = {
    id: "legacy-default",
    name: "colony",
    relayUrl: `${defaultRelayUrl}/`,
    pubkey: "legacy-pubkey",
    addedAt: "2026-08-11T12:00:00.000Z",
  };
  const candidate = {
    activePubkey: community.pubkey,
    activeCommunityId: community.id,
    autoConnectDefaultRelay: false,
    communities: [community],
    defaultRelayUrl,
  };

  assert.equal(shouldRecoverLegacyAutoConnectedCommunity(candidate), true);
  assert.equal(
    shouldRecoverLegacyAutoConnectedCommunity({
      ...candidate,
      activePubkey: "replacement-identity",
    }),
    false,
  );
  assert.equal(
    shouldRecoverLegacyAutoConnectedCommunity({
      ...candidate,
      autoConnectDefaultRelay: true,
    }),
    false,
  );
  assert.equal(
    shouldRecoverLegacyAutoConnectedCommunity({
      ...candidate,
      activeCommunityId: "another-community",
    }),
    false,
  );
  assert.equal(
    shouldRecoverLegacyAutoConnectedCommunity({
      ...candidate,
      communities: [
        community,
        { ...community, id: "second", relayUrl: "wss://elsewhere.example" },
      ],
    }),
    false,
  );
  assert.equal(
    shouldRecoverLegacyAutoConnectedCommunity({
      ...candidate,
      communities: [{ ...community, relayUrl: "wss://elsewhere.example" }],
    }),
    false,
  );
  assert.equal(
    shouldRecoverLegacyAutoConnectedCommunity({
      ...candidate,
      communities: [{ ...community, name: "My Colony" }],
    }),
    false,
  );
  assert.equal(
    shouldRecoverLegacyAutoConnectedCommunity({
      ...candidate,
      communities: [{ ...community, token: "invite-token" }],
    }),
    false,
  );
  assert.equal(
    shouldRecoverLegacyAutoConnectedCommunity({
      ...candidate,
      communities: [{ ...community, reposDir: "/Users/example/code" }],
    }),
    false,
  );
});

test("legacy default community quarantine preserves a restorable snapshot", () => {
  const community = {
    id: "legacy-default",
    name: "colony",
    relayUrl: "wss://relay.colony.ainative.ventures",
    pubkey: "legacy-pubkey",
    addedAt: "2026-08-11T12:00:00.000Z",
  };
  const storage = createMemoryStorage({
    "buzz-communities": JSON.stringify([community]),
    "buzz-active-community-id": community.id,
    "buzz-community-destinations": JSON.stringify({
      [community.id]: { kind: "home" },
    }),
  });
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage };

  assert.equal(
    quarantineLegacyAutoConnectedCommunity({
      activePubkey: community.pubkey,
      autoConnectDefaultRelay: false,
      defaultRelayUrl: community.relayUrl,
    }),
    true,
  );
  assert.equal(storage.getItem("buzz-communities"), null);
  assert.equal(storage.getItem("buzz-active-community-id"), null);
  assert.deepEqual(
    JSON.parse(storage.getItem("buzz-legacy-auto-connect-recovery.v1")),
    {
      activeCommunityId: community.id,
      communities: [community],
      communityDestinations: JSON.stringify({
        [community.id]: { kind: "home" },
      }),
      version: 1,
    },
  );
  assert.equal(hasLegacyAutoConnectRecovery(community.pubkey), true);
  assert.equal(hasLegacyAutoConnectRecovery("different-pubkey"), false);
  assert.equal(restoreLegacyAutoConnectedCommunity("different-pubkey"), false);
  assert.equal(restoreLegacyAutoConnectedCommunity(community.pubkey), true);
  assert.deepEqual(JSON.parse(storage.getItem("buzz-communities")), [
    community,
  ]);
  assert.equal(storage.getItem("buzz-active-community-id"), community.id);
  assert.deepEqual(JSON.parse(storage.getItem("buzz-community-destinations")), {
    [community.id]: { kind: "home" },
  });
  assert.equal(hasLegacyAutoConnectRecovery(community.pubkey), false);

  storage.setItem("buzz-communities", JSON.stringify([community]));
  storage.setItem("buzz-active-community-id", community.id);
  storage.setItem(
    "buzz-legacy-auto-connect-recovery.v1",
    JSON.stringify({ sentinel: true }),
  );
  assert.equal(
    quarantineLegacyAutoConnectedCommunity({
      activePubkey: community.pubkey,
      autoConnectDefaultRelay: false,
      defaultRelayUrl: community.relayUrl,
    }),
    false,
  );
  assert.deepEqual(JSON.parse(storage.getItem("buzz-communities")), [
    community,
  ]);
  assert.deepEqual(
    JSON.parse(storage.getItem("buzz-legacy-auto-connect-recovery.v1")),
    { sentinel: true },
  );
});

test("legacy community restore resumes after each interrupted write", () => {
  const community = {
    id: "legacy-default",
    name: "colony",
    relayUrl: "wss://relay.colony.ainative.ventures",
    pubkey: "legacy-pubkey",
    addedAt: "2026-08-11T12:00:00.000Z",
  };
  const destinations = JSON.stringify({
    [community.id]: { kind: "home" },
  });
  const recovery = JSON.stringify({
    activeCommunityId: community.id,
    communities: [community],
    communityDestinations: destinations,
    version: 1,
  });

  for (const failedKey of [
    "buzz-community-destinations",
    "buzz-active-community-id",
    "buzz-communities",
  ]) {
    const storage = createMemoryStorage({
      "buzz-legacy-auto-connect-recovery.v1": recovery,
    });
    const setItem = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === failedKey) throw new Error("simulated interruption");
      setItem(key, value);
    };
    globalThis.localStorage = storage;
    globalThis.window = { localStorage: storage };

    assert.equal(
      restoreLegacyAutoConnectedCommunity(community.pubkey),
      false,
      failedKey,
    );
    assert.equal(
      storage.getItem("buzz-legacy-auto-connect-recovery.v1"),
      recovery,
      failedKey,
    );

    storage.setItem = setItem;
    assert.equal(
      restoreLegacyAutoConnectedCommunity(community.pubkey),
      true,
      failedKey,
    );
    assert.equal(
      storage.getItem("buzz-communities"),
      JSON.stringify([community]),
      failedKey,
    );
    assert.equal(
      storage.getItem("buzz-active-community-id"),
      community.id,
      failedKey,
    );
    assert.equal(
      storage.getItem("buzz-community-destinations"),
      destinations,
      failedKey,
    );
    assert.equal(
      storage.getItem("buzz-legacy-auto-connect-recovery.v1"),
      null,
      failedKey,
    );
  }
});

test("failed quarantine write leaves the live community untouched", () => {
  const community = {
    id: "legacy-default",
    name: "colony",
    relayUrl: "wss://relay.colony.ainative.ventures",
    pubkey: "legacy-pubkey",
    addedAt: "2026-08-11T12:00:00.000Z",
  };
  const storage = createMemoryStorage({
    "buzz-communities": JSON.stringify([community]),
    "buzz-active-community-id": community.id,
  });
  storage.setItem = (key, value) => {
    if (key === "buzz-legacy-auto-connect-recovery.v1") {
      throw new Error("QuotaExceededError");
    }
    storage.values.set(key, String(value));
  };
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage };

  assert.equal(
    quarantineLegacyAutoConnectedCommunity({
      activePubkey: community.pubkey,
      autoConnectDefaultRelay: false,
      defaultRelayUrl: community.relayUrl,
    }),
    false,
  );
  assert.deepEqual(JSON.parse(storage.getItem("buzz-communities")), [
    community,
  ]);
  assert.equal(storage.getItem("buzz-active-community-id"), community.id);
});

test("legacy default community quarantine revalidates live storage before clearing", () => {
  const community = {
    id: "legacy-default",
    name: "colony",
    relayUrl: "wss://relay.colony.ainative.ventures",
    pubkey: "legacy-pubkey",
    addedAt: "2026-08-11T12:00:00.000Z",
  };
  const newerCommunity = {
    ...community,
    id: "newer-community",
    relayUrl: "wss://newer.example.com",
  };
  const storage = createMemoryStorage({
    "buzz-communities": JSON.stringify([community, newerCommunity]),
    "buzz-active-community-id": community.id,
  });
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage };

  assert.equal(
    quarantineLegacyAutoConnectedCommunity({
      activePubkey: community.pubkey,
      autoConnectDefaultRelay: false,
      defaultRelayUrl: community.relayUrl,
    }),
    false,
  );
  assert.deepEqual(JSON.parse(storage.getItem("buzz-communities")), [
    community,
    newerCommunity,
  ]);
  assert.equal(storage.getItem("buzz-active-community-id"), community.id);
  assert.equal(storage.getItem("buzz-legacy-auto-connect-recovery.v1"), null);
});

test("legacy default community quarantine resumes an interrupted matching recovery", () => {
  const community = {
    id: "legacy-default",
    name: "colony",
    relayUrl: "wss://relay.colony.ainative.ventures",
    pubkey: "legacy-pubkey",
    addedAt: "2026-08-11T12:00:00.000Z",
  };
  const destinations = JSON.stringify({
    [community.id]: { kind: "home" },
  });
  const storage = createMemoryStorage({
    "buzz-communities": JSON.stringify([community]),
    "buzz-active-community-id": community.id,
    "buzz-community-destinations": destinations,
    "buzz-legacy-auto-connect-recovery.v1": JSON.stringify({
      activeCommunityId: community.id,
      communities: [community],
      communityDestinations: destinations,
      version: 1,
    }),
  });
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage };

  assert.equal(
    quarantineLegacyAutoConnectedCommunity({
      activePubkey: community.pubkey,
      autoConnectDefaultRelay: false,
      defaultRelayUrl: community.relayUrl,
    }),
    true,
  );
  assert.equal(storage.getItem("buzz-communities"), null);
  assert.equal(storage.getItem("buzz-active-community-id"), null);
  assert.equal(
    storage.getItem("buzz-legacy-auto-connect-recovery.v1") !== null,
    true,
  );
});

test("failed first-community write preserves existing community data", () => {
  const storage = createMemoryStorage({
    "buzz-communities": '[{"id":"existing"}]',
    "buzz-workspaces": '[{"id":"legacy"}]',
    "buzz-active-workspace-id": "legacy",
  });
  storage.setItem = (key, value) => {
    if (key === "buzz-communities") {
      throw new Error("QuotaExceededError");
    }
    storage.values.set(key, String(value));
  };
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage };

  assert.equal(initFirstCommunity("wss://relay.example.com", "pubkey"), null);
  assert.equal(storage.getItem("buzz-communities"), '[{"id":"existing"}]');
  assert.equal(storage.getItem("buzz-active-community-id"), null);
  assert.equal(storage.getItem("buzz-workspaces"), '[{"id":"legacy"}]');
  assert.equal(storage.getItem("buzz-active-workspace-id"), "legacy");
});

test("clearCommunityStorage removes new and legacy state", () => {
  const storage = createMemoryStorage({
    "buzz-communities": "new",
    "buzz-active-community-id": "new",
    "buzz-workspaces": "old",
    "buzz-active-workspace-id": "old",
  });

  clearCommunityStorage(storage);
  migrateLegacyCommunityStorage(storage);

  assert.equal(storage.length, 0);
});

test("loading an existing community clears stale final-leave discovery", () => {
  const storage = createMemoryStorage({
    "buzz-communities": '[{"id":"joined"}]',
    "buzz-community-discovery-after-leave": "1",
  });
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage };

  assert.deepEqual(loadCommunities(), [{ id: "joined" }]);
  assert.equal(loadCommunityDiscoveryAfterLeave(storage), false);
});

test("completed final leave persists discovery until a community is saved", () => {
  const storage = createMemoryStorage();
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage };

  assert.equal(markCommunityDiscoveryAfterLeave(storage), true);
  assert.equal(loadCommunityDiscoveryAfterLeave(storage), true);

  assert.equal(saveCommunities([{ id: "joined" }]), true);
  assert.equal(loadCommunityDiscoveryAfterLeave(storage), false);
});

test("clearCommunityStorage preserves completed final-leave discovery", () => {
  const storage = createMemoryStorage({
    "buzz-communities": "new",
    "buzz-active-community-id": "new",
    "buzz-workspaces": "old",
    "buzz-active-workspace-id": "old",
    "buzz-community-discovery-after-leave": "1",
  });

  clearCommunityStorage(storage);
  migrateLegacyCommunityStorage(storage);

  assert.equal(storage.length, 1);
  assert.equal(loadCommunityDiscoveryAfterLeave(storage), true);
});
