import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { createFirstJobTeamAdapter } from "./firstJobTeam.ts";

const key = (last) => Uint8Array.from([...Array(31).fill(0), last]);
const OWNER = getPublicKey(key(1));
const OTHER = getPublicKey(key(2));
const SCOUT = "a".repeat(64);
const WORKER = "b".repeat(64);
const SCOPE = {
  ownerPubkey: OWNER,
  relayUrl: "wss://company.test",
  channelId: "welcome",
  threadRootId: "c".repeat(64),
  requestId: "first-job",
};
const TEAM = { scoutPubkey: SCOUT, workerPubkey: WORKER };

function head(pubkey, tier, { author = 1, at = 100, manager } = {}) {
  return finalizeEvent(
    {
      kind: 30177,
      created_at: at,
      tags: [["d", pubkey], ...(manager ? [["manager", manager]] : [])],
      content: JSON.stringify({
        name: "This name gives no rank",
        tier,
        role_id: tier === "executive" ? "chief-of-staff" : "writer",
      }),
    },
    key(author),
  );
}

function agent(pubkey, personaId) {
  return {
    pubkey,
    personaId,
    relayUrl: SCOPE.relayUrl,
    agentCommand: "/app/buzz-agent",
    backend: { type: "local" },
    respondTo: "owner-only",
    respondToAllowlist: [],
    personaOrphaned: false,
    name: "Anything",
    status: "stopped",
  };
}

function fixture() {
  const data = {
    agents: [agent(WORKER, "writer"), agent(SCOUT, "builtin:fizz")],
    personas: [
      { id: "writer", isActive: true },
      { id: "builtin:fizz", isActive: true },
    ],
    runtimes: [{ availability: "available", command: "buzz-agent" }],
    members: [SCOUT, WORKER].map((pubkey) => ({
      pubkey,
      isAgent: true,
      role: "bot",
    })),
    owners: [{ pubkey: OWNER, role: "owner" }],
    heads: [
      head(SCOUT, "executive"),
      head(WORKER, "worker", { manager: "d".repeat(64) }),
    ],
  };
  const starts = [];
  const statuses = new Map();
  let observed = false;
  let time = 0;
  let current = true;
  const deps = {
    assertCurrent: async () => {
      if (!current) throw new Error("scope changed");
    },
    listAgents: async () => data.agents,
    listPersonas: async () => data.personas,
    listRuntimes: async () => data.runtimes,
    listMembers: async (channel) => {
      assert.equal(channel, SCOPE.channelId);
      return data.members;
    },
    listOwners: async () => data.owners,
    readHeads: async () => data.heads,
    ensureObserver: async () => {
      observed = true;
    },
    listRuntimeStatuses: async () => [...statuses.values()],
    now: () => time,
    delay: async (ms) => {
      time += ms;
    },
    startRuntime: async (...args) => {
      starts.push(args);
      const status = {
        pubkey: args[0],
        relayUrl: args[1],
        localSetup: true,
        lifecycle: "listening",
        pid: args[0] === WORKER ? 101 : 102,
        error: null,
      };
      statuses.set(args[0], status);
      return status;
    },
  };
  return {
    data,
    starts,
    deps,
    statuses,
    observed: () => observed,
    adapter: createFirstJobTeamAdapter(deps),
    stale: () => {
      current = false;
    },
  };
}

test("selects a signed, existing pair deterministically without changing its reporting line", async () => {
  const f = fixture();
  const before = structuredClone(f.data);
  assert.deepEqual(await f.adapter.ensureFirstJobTeam(SCOPE), TEAM);
  f.data.agents.reverse();
  f.data.heads.reverse();
  assert.deepEqual(await f.adapter.ensureFirstJobTeam(SCOPE), TEAM);
  assert.deepEqual(
    structuredClone(f.data.heads.find((event) => event.tags[0][1] === WORKER)),
    before.heads[1],
  );
  assert.deepEqual(f.starts, []);
});

for (const [label, change] of Object.entries({
  "worker missing": (d) => {
    d.agents = d.agents.filter((a) => a.pubkey !== WORKER);
  },
  "wrong relay": (d) => {
    d.agents[0].relayUrl = "wss://other.test";
  },
  "blank relay": (d) => {
    d.agents[0].relayUrl = "";
  },
  "wrong owner head": (d) => {
    d.heads[1] = head(WORKER, "worker", { author: 2 });
  },
  "newer other owner supersedes approval": (d) => {
    d.owners.push({ pubkey: OTHER, role: "owner" });
    d.heads.push(head(WORKER, "worker", { author: 2, at: 200 }));
  },
  "current account no longer owner": (d) => {
    d.owners[0].role = "member";
  },
  "worker no longer member": (d) => {
    d.members = d.members.filter((m) => m.pubkey !== WORKER);
  },
  "Chief no longer member": (d) => {
    d.members = d.members.filter((m) => m.pubkey !== SCOUT);
  },
  "member is not an agent": (d) => {
    d.members[1].isAgent = false;
  },
  "unsupported runtime": (d) => {
    d.agents[0].agentCommand = "unknown-command";
  },
  "unavailable runtime": (d) => {
    d.runtimes[0].availability = "not_installed";
  },
  "remote runtime": (d) => {
    d.agents[0].backend = { type: "provider", id: "remote" };
  },
  "broader access": (d) => {
    d.agents[0].respondTo = "anyone";
  },
  "unapproved allowlist": (d) => {
    d.agents[0].respondTo = "allowlist";
  },
  "inactive persona": (d) => {
    d.personas[0].isActive = false;
  },
  "orphaned persona": (d) => {
    d.agents[0].personaOrphaned = true;
  },
  "no persona": (d) => {
    d.agents[0].personaId = null;
  },
  "name cannot supply Chief persona": (d) => {
    d.agents[1].name = "Scout";
    d.agents[1].personaId = "writer";
  },
  "name cannot supply worker rank": (d) => {
    d.heads[1] = head(WORKER, undefined);
  },
  "wrong worker rank": (d) => {
    d.heads[1] = head(WORKER, "leader");
  },
  "wrong Chief rank": (d) => {
    d.heads[0] = head(SCOUT, "leader");
  },
  "new malformed head cannot resurrect old rank": (d) => {
    d.heads.push(head(WORKER, "unknown", { at: 200 }));
  },
  "tampered signature": (d) => {
    d.heads[1] = {
      ...d.heads[1],
      content: JSON.stringify({ tier: "worker", injected: true }),
    };
  },
})) {
  test(`blocks when ${label}`, async () => {
    const f = fixture();
    change(f.data);
    assert.equal(await f.adapter.ensureFirstJobTeam(SCOPE), null);
    assert.deepEqual(f.starts, []);
  });
}

test("an employee role override cannot be bypassed using the managed worker tier", async () => {
  const f = fixture();
  f.data.heads.push(
    finalizeEvent(
      {
        kind: 30190,
        created_at: 100,
        tags: [
          ["d", OTHER],
          ["role", "writer"],
          ["rank", "executive"],
        ],
        content: "",
      },
      key(2),
    ),
  );
  assert.equal(await f.adapter.ensureFirstJobTeam(SCOPE), null);
});

test("starts worker before Chief with the exact owner and relay", async () => {
  const f = fixture();
  await f.adapter.startFirstJobTeam(SCOPE, TEAM);
  assert.deepEqual(f.starts, [
    [WORKER, SCOPE.relayUrl, OWNER],
    [SCOUT, SCOPE.relayUrl, OWNER],
  ]);
});

test("a saved pair stays pinned when an earlier eligible worker appears", async () => {
  const f = fixture();
  const earlier = "1".repeat(64);
  f.data.agents.push(agent(earlier, "writer"));
  f.data.heads.push(head(earlier, "worker"));
  f.data.members.push({ pubkey: earlier, isAgent: true, role: "bot" });
  assert.equal(
    (await f.adapter.ensureFirstJobTeam(SCOPE)).workerPubkey,
    earlier,
  );
  assert.deepEqual(await f.adapter.ensureFirstJobTeam(SCOPE, TEAM), TEAM);
  f.data.agents = f.data.agents.filter((item) => item.pubkey !== WORKER);
  assert.equal(await f.adapter.ensureFirstJobTeam(SCOPE, TEAM), null);
});

test("actual read failures propagate instead of becoming missing staffing", async () => {
  const f = fixture();
  const failure = new Error("native roster unavailable");
  f.deps.listAgents = async () => {
    throw failure;
  };
  await assert.rejects(
    f.adapter.ensureFirstJobTeam(SCOPE),
    (error) => error === failure,
  );
});

test("scope changes during reads never select or start a team", async () => {
  const f = fixture();
  f.deps.readHeads = async () => {
    f.stale();
    return f.data.heads;
  };
  await assert.rejects(f.adapter.ensureFirstJobTeam(SCOPE), /scope changed/);
  assert.deepEqual(f.starts, []);
});

test("runtime failures propagate and do not start the Chief", async () => {
  const f = fixture();
  const failure = new Error("native isolation unavailable");
  f.deps.startRuntime = async (...args) => {
    f.starts.push(args);
    throw failure;
  };
  await assert.rejects(
    f.adapter.startFirstJobTeam(SCOPE, TEAM),
    (error) => error === failure,
  );
  assert.equal(f.starts.length, 1);
});

test("a failed runtime status is a real error", async () => {
  const f = fixture();
  f.deps.startRuntime = async (pubkey, relayUrl) => ({
    pubkey,
    relayUrl,
    localSetup: true,
    lifecycle: "failed",
    error: "setup failed",
  });
  await assert.rejects(
    f.adapter.startFirstJobTeam(SCOPE, TEAM),
    /setup failed/,
  );
});

test("scope changes during worker start prevent starting the Chief", async () => {
  const f = fixture();
  const start = f.deps.startRuntime;
  f.deps.startRuntime = async (...args) => {
    const status = await start(...args);
    f.stale();
    return status;
  };
  await assert.rejects(
    f.adapter.startFirstJobTeam(SCOPE, TEAM),
    /scope changed/,
  );
  assert.equal(f.starts.length, 1);
});

test("staffing is reread before starting the second teammate", async () => {
  const f = fixture();
  const start = f.deps.startRuntime;
  f.deps.startRuntime = async (...args) => {
    const status = await start(...args);
    f.data.members = [];
    return status;
  };
  await assert.rejects(
    f.adapter.startFirstJobTeam(SCOPE, TEAM),
    /no longer available/,
  );
  assert.equal(f.starts.length, 1);
});

test("observer subscription exists before either runtime starts", async () => {
  const f = fixture();
  const start = f.deps.startRuntime;
  f.deps.startRuntime = async (...args) => {
    assert.equal(f.observed(), true);
    return start(...args);
  };
  await f.adapter.startFirstJobTeam(SCOPE, TEAM);
});

test("waits for both actual runtime pairs to listen after delayed startup", async () => {
  const f = fixture();
  const start = f.deps.startRuntime;
  f.deps.startRuntime = async (...args) => {
    const status = await start(...args);
    status.lifecycle = "starting";
    return status;
  };
  let polls = 0;
  f.deps.listRuntimeStatuses = async () => {
    polls++;
    return [...f.statuses.values()].map((status) => ({
      ...status,
      lifecycle:
        polls >= (status.pubkey === WORKER ? 2 : 3) ? "listening" : "starting",
    }));
  };
  await f.adapter.startFirstJobTeam(SCOPE, TEAM);
  assert.equal(polls, 3);
});

for (const [label, change, error] of [
  [
    "worker failed",
    (rows) => {
      rows[0].lifecycle = "failed";
      rows[0].error = "worker boot failed";
    },
    /worker boot failed/,
  ],
  [
    "worker stopped",
    (rows) => {
      rows[0].lifecycle = "stopped";
    },
    /could not start/,
  ],
  [
    "no live process",
    (rows) => {
      rows[0].pid = null;
    },
    /could not start/,
  ],
  [
    "different process",
    (rows) => {
      rows[0].pid = 999;
    },
    /changed while starting/,
  ],
  [
    "lost setup",
    (rows) => {
      rows[0].localSetup = false;
    },
    /could not start/,
  ],
  [
    "wrong relay",
    (rows) => {
      rows[0].relayUrl = "wss://other.test";
    },
    /still getting ready/,
  ],
  [
    "missing worker",
    (rows) => {
      rows.shift();
    },
    /still getting ready/,
  ],
  [
    "never listening",
    (rows) => {
      rows[0].lifecycle = "starting";
    },
    /still getting ready/,
  ],
]) {
  test(`readiness refuses ${label}`, async () => {
    const f = fixture();
    f.deps.listRuntimeStatuses = async () => {
      const rows = structuredClone([...f.statuses.values()]);
      change(rows);
      return rows;
    };
    await assert.rejects(f.adapter.startFirstJobTeam(SCOPE, TEAM), error);
  });
}

test("scope changes while observing or waiting cannot finish readiness", async () => {
  for (const boundary of ["ensureObserver", "listRuntimeStatuses"]) {
    const f = fixture();
    const original = f.deps[boundary];
    f.deps[boundary] = async (...args) => {
      const result = await original(...args);
      f.stale();
      return result;
    };
    await assert.rejects(
      f.adapter.startFirstJobTeam(SCOPE, TEAM),
      /scope changed/,
    );
    if (boundary === "ensureObserver") assert.equal(f.starts.length, 0);
  }
});

test("observer and readiness read failures remain actionable errors", async () => {
  for (const boundary of ["ensureObserver", "listRuntimeStatuses"]) {
    const f = fixture();
    const failure = new Error(`unavailable ${boundary}`);
    f.deps[boundary] = async () => {
      throw failure;
    };
    await assert.rejects(
      f.adapter.startFirstJobTeam(SCOPE, TEAM),
      (error) => error === failure,
    );
    if (boundary === "ensureObserver") assert.equal(f.starts.length, 0);
  }
});

test("a failed Chief is reported even while the worker is still starting", async () => {
  const f = fixture();
  f.deps.listRuntimeStatuses = async () =>
    [...f.statuses.values()].map((status) => ({
      ...status,
      lifecycle: status.pubkey === WORKER ? "starting" : "failed",
      error: status.pubkey === SCOUT ? "Chief could not connect" : null,
    }));
  await assert.rejects(
    f.adapter.startFirstJobTeam(SCOPE, TEAM),
    /Chief could not connect/,
  );
});

test("team preview retries only the rate-limited read after its cooldown", async () => {
  const f = fixture();
  let reads = 0;
  let agentReads = 0;
  const waits = [];
  f.deps.listAgents = async () => {
    agentReads++;
    return f.data.agents;
  };
  f.deps.readHeads = async () => {
    if (++reads === 1)
      throw new Error("rate-limited: quota exceeded; retry in 5s");
    return f.data.heads;
  };
  f.deps.delay = async (ms) => {
    waits.push(ms);
  };
  assert.deepEqual(await f.adapter.ensureFirstJobTeam(SCOPE), TEAM);
  assert.equal(reads, 2);
  assert.equal(agentReads, 1);
  assert.deepEqual(waits, [5000]);
  assert.deepEqual(f.starts, []);
});

test("team preview stops on scope changes, permanent errors, long cooldowns and exhausted retries", async () => {
  for (const reason of [
    "invalid signature",
    "rate-limited: quota exceeded; retry in 60s",
    "rate-limited: quota exceeded; retry in 1s",
  ]) {
    const f = fixture();
    let reads = 0;
    f.deps.readHeads = async () => {
      reads++;
      throw new Error(reason);
    };
    await assert.rejects(f.adapter.ensureFirstJobTeam(SCOPE), {
      message: reason,
    });
    assert.equal(reads, reason.endsWith("in 1s") ? 3 : 1);
    assert.deepEqual(f.starts, []);
  }
  const f = fixture();
  let reads = 0;
  f.deps.readHeads = async () => {
    reads++;
    throw new Error("rate-limited: quota exceeded; retry in 1s");
  };
  f.deps.delay = async () => f.stale();
  await assert.rejects(f.adapter.ensureFirstJobTeam(SCOPE), /scope changed/);
  assert.equal(reads, 1);
});
