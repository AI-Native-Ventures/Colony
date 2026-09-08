import assert from "node:assert/strict";
import test from "node:test";

import {
  createFirstJobStarter,
  FIRST_JOB_BRIEF_MAX_LENGTH,
} from "./firstJobStart.ts";

const SCOPE = {
  ownerPubkey: "owner-a",
  relayUrl: "wss://company.test",
  channelId: "welcome-a",
  threadRootId: "root-a",
  requestId: "request-a",
};
const TEAM = { scoutPubkey: "scout-a", workerPubkey: "worker-a" };
const BRIEF = "Draft five captions and visual briefs for review.";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  const calls = [];
  let current = true;
  const dependencies = {
    assertCurrent: async () => {
      if (!current) throw new Error("Scope changed");
    },
    ensureConfig: async () => {
      calls.push("config");
      return { credentialMode: "colony_credits" };
    },
    readAvailableCredits: async () => {
      calls.push("credits");
      return 1n;
    },
    ensureTeam: async () => {
      calls.push("team");
      return TEAM;
    },
    dispatchOnce: async (input) => {
      calls.push(["dispatch", input]);
      return { eventId: "accepted-event", taskId: "canonical-task" };
    },
    ...overrides,
  };
  return {
    calls,
    dependencies,
    start: createFirstJobStarter(dependencies),
    stale: () => {
      current = false;
    },
  };
}

test("nonpositive credits stop before team preparation or dispatch", async () => {
  for (const balance of [0n, -1n]) {
    const f = fixture({ readAvailableCredits: async () => balance });
    assert.deepEqual(await f.start(SCOPE, BRIEF), { kind: "needs-credits" });
    assert.deepEqual(f.calls, ["config"]);
  }
});

test("unknown credits stay a retryable error, never zero or successful work", async () => {
  const failure = new Error("Balance unavailable");
  const f = fixture({
    readAvailableCredits: async () => {
      throw failure;
    },
  });
  await assert.rejects(f.start(SCOPE, BRIEF), (error) => error === failure);
  assert.deepEqual(f.calls, ["config"]);
});

test("malformed credit data does not authorize a dispatch", async () => {
  for (const balance of [undefined, null, "1", 1, NaN]) {
    const f = fixture({ readAvailableCredits: async () => balance });
    await assert.rejects(f.start(SCOPE, BRIEF), /credit/i);
    assert.deepEqual(f.calls, ["config"]);
  }
});

test("an unavailable approved worker is visibly blocked", async () => {
  const f = fixture({ ensureTeam: async () => null });
  const result = await f.start(SCOPE, BRIEF);
  assert.equal(result.kind, "blocked");
  assert.match(result.message, /worker/i);
  assert.deepEqual(f.calls, ["config", "credits"]);
});

test("unapproved business setup blocks before preparing a permanent task request", async () => {
  const message = "Review your business setup with your Chief of Staff first.";
  const f = fixture({ checkBusiness: async () => message });
  assert.deepEqual(await f.start(SCOPE, BRIEF), { kind: "blocked", message });
  assert.deepEqual(f.calls, ["config", "credits"]);
});

test("an unreadable business setup is a retryable read error", async () => {
  const f = fixture({
    checkBusiness: async () => {
      throw new Error("Business read unavailable");
    },
  });
  await assert.rejects(f.start(SCOPE, BRIEF), /Business read unavailable/);
  assert.deepEqual(f.calls, ["config", "credits"]);
});

test("configuration rejection never reads credits or starts work", async () => {
  const failure = new Error("Could not save teammate settings");
  const f = fixture({
    ensureConfig: async () => {
      throw failure;
    },
  });
  await assert.rejects(f.start(SCOPE, BRIEF), (error) => error === failure);
  assert.deepEqual(f.calls, []);
});

test("supported own-key configuration never calls Colony Credits", async () => {
  const f = fixture({ ensureConfig: async () => ({ credentialMode: "byok" }) });
  const result = await f.start(SCOPE, BRIEF);
  assert.equal(result.kind, "sent");
  assert.equal(
    f.calls.some((entry) => entry === "credits"),
    false,
  );
});

test("a positive fractional-cent balance can dispatch the canonical request", async () => {
  const f = fixture();
  assert.deepEqual(await f.start(SCOPE, `  ${BRIEF}  `), {
    kind: "sent",
    eventId: "accepted-event",
    taskId: "canonical-task",
  });
  assert.deepEqual(f.calls, [
    "config",
    "credits",
    "team",
    ["dispatch", { scope: SCOPE, content: BRIEF, team: TEAM }],
  ]);
});

test("invalid or unbounded briefs fail before any adapter call", async () => {
  for (const brief of ["", "   ", "x".repeat(FIRST_JOB_BRIEF_MAX_LENGTH + 1)]) {
    const f = fixture();
    await assert.rejects(f.start(SCOPE, brief), /brief/i);
    assert.deepEqual(f.calls, []);
  }
});

test("stale scope at entry never touches configuration", async () => {
  const f = fixture();
  f.stale();
  await assert.rejects(f.start(SCOPE, BRIEF), /Scope changed/);
  assert.deepEqual(f.calls, []);
});

for (const step of [
  "ensureConfig",
  "readAvailableCredits",
  "ensureTeam",
  "dispatchOnce",
]) {
  test(`scope changed during ${step} cannot advance or claim success`, async () => {
    const f = fixture();
    const original = f.dependencies[step];
    const reached = deferred();
    const release = deferred();
    f.dependencies[step] = async (...args) => {
      const result = await original(...args);
      reached.resolve();
      await release.promise;
      return result;
    };
    const pending = f.start(SCOPE, BRIEF);
    await reached.promise;
    const callsAtSwitch = f.calls.length;
    f.stale();
    release.resolve();
    await assert.rejects(pending, /Scope changed/);
    assert.equal(f.calls.length, callsAtSwitch);
  });
}

test("duplicate in-flight Start shares one captured request", async () => {
  const gate = deferred();
  let configurations = 0;
  const f = fixture({
    ensureConfig: async () => {
      configurations += 1;
      await gate.promise;
      return { credentialMode: "byok" };
    },
  });
  const mutableScope = { ...SCOPE };
  const one = f.start(mutableScope, BRIEF);
  const two = f.start(
    { ...SCOPE },
    "An edit while the first request is pending",
  );
  mutableScope.channelId = "another-channel";
  gate.resolve();
  assert.deepEqual(await one, await two);
  assert.equal(configurations, 1);
  const dispatches = f.calls.filter(Array.isArray);
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0][1].scope, SCOPE);
  assert.equal(dispatches[0][1].content, BRIEF);
});

test("different scopes do not share an in-flight result", async () => {
  const f = fixture();
  await Promise.all([
    f.start(SCOPE, BRIEF),
    f.start({ ...SCOPE, ownerPubkey: "owner-b" }, BRIEF),
  ]);
  assert.equal(f.calls.filter(Array.isArray).length, 2);
});

test("uncertain dispatch stays an error; explicit retry preserves request identity", async () => {
  const seen = [];
  const uncertain = new Error("Request acceptance is uncertain");
  const f = fixture({
    dispatchOnce: async (input) => {
      seen.push(input);
      if (seen.length === 1) throw uncertain;
      return { eventId: "same-prepared-event", taskId: "same-task" };
    },
  });
  await assert.rejects(f.start(SCOPE, BRIEF), (error) => error === uncertain);
  assert.deepEqual(await f.start(SCOPE, BRIEF), {
    kind: "sent",
    eventId: "same-prepared-event",
    taskId: "same-task",
  });
  assert.deepEqual(seen[0], seen[1]);
});
