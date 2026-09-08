import assert from "node:assert/strict";
import test from "node:test";

import { createFirstJobCredits } from "./firstJobCredits.ts";

const SCOPE = {
  ownerPubkey: "owner-a",
  relayUrl: "wss://company.test",
  channelId: "welcome-a",
  threadRootId: "root-a",
  requestId: "request-a",
};
const INPUT = { packId: "small", email: "owner@example.test" };
const CATALOGUE = {
  currency: "USD",
  packs: [
    {
      id: "small",
      name: "Small",
      usdCents: 500,
      zarCents: 9000,
      grantNanousd: 5_000_000_000,
    },
  ],
};
const CHECKOUT = {
  reference: "reference-a",
  authorizationUrl: "https://pay.example.test/a",
};
const READY = { phase: "ready", ...INPUT, ...CHECKOUT };

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function fixture(overrides = {}) {
  const calls = [];
  const records = new Map();
  const locks = new Map();
  let current = true;
  const key = (scope) => JSON.stringify(scope);
  const dependencies = {
    assertCurrent: async () => {
      if (!current) throw new Error("Scope changed");
    },
    payments: {
      packs: async () => {
        calls.push("packs");
        return CATALOGUE;
      },
      createTransaction: async (...args) => {
        calls.push(["initialize", ...args]);
        return CHECKOUT;
      },
      verify: async (reference) => {
        calls.push(["verify", reference]);
        return { paid: true, usdCents: 500 };
      },
      ...overrides.payments,
    },
    readAvailableCredits: async () => {
      calls.push("balance");
      return 1n;
    },
    openUrl: async (url) => {
      calls.push(["open", url]);
    },
    readAttempt: async (scope) => records.get(key(scope)) ?? null,
    writeAttempt: async (scope, attempt) => {
      calls.push(["save", attempt.phase]);
      records.set(key(scope), structuredClone(attempt));
    },
    withAttemptLock: async (scope, action) => {
      const previous = locks.get(key(scope)) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(action);
      locks.set(key(scope), next);
      return next;
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([name]) => name !== "payments"),
    ),
  };
  return {
    calls,
    dependencies,
    controller: createFirstJobCredits(dependencies),
    record: () => records.get(key(SCOPE)),
    seed: (attempt) => records.set(key(SCOPE), structuredClone(attempt)),
    stale: () => {
      current = false;
    },
  };
}

test("prices are read from the existing service and failures are not an empty free catalogue", async () => {
  const f = fixture();
  assert.deepEqual(await f.controller.loadPacks(SCOPE), CATALOGUE);
  const failure = new Error("Prices unavailable");
  f.dependencies.payments.packs = async () => {
    throw failure;
  };
  await assert.rejects(
    f.controller.loadPacks(SCOPE),
    (error) => error === failure,
  );
});

test("checkout claims uncertainty before initialization and saves reference before opening", async () => {
  const f = fixture();
  assert.equal((await f.controller.begin(SCOPE, INPUT)).kind, "opened");
  assert.deepEqual(f.calls, [
    "packs",
    ["save", "initializing"],
    ["initialize", "small", "owner@example.test"],
    ["save", "ready"],
    ["open", CHECKOUT.authorizationUrl],
  ]);
  assert.deepEqual(f.record(), READY);
});

test("initialization timeout stays uncertain across controller recreation and cannot charge twice", async () => {
  let initializes = 0;
  const f = fixture({
    payments: {
      createTransaction: async () => {
        initializes += 1;
        throw new Error("Response lost after initialization");
      },
    },
  });
  assert.equal(
    (await f.controller.begin(SCOPE, INPUT)).kind,
    "initialization-uncertain",
  );
  const relaunched = createFirstJobCredits(f.dependencies);
  assert.equal(
    (await relaunched.begin(SCOPE, INPUT)).kind,
    "initialization-uncertain",
  );
  assert.equal(initializes, 1);
  assert.equal(f.record().phase, "initializing");
  assert.equal(
    f.calls.some((call) => Array.isArray(call) && call[0] === "open"),
    false,
  );
});

test("a failed browser handoff retains and reopens the same checkout", async () => {
  let opens = 0;
  const f = fixture({
    openUrl: async () => {
      opens += 1;
      if (opens === 1) throw new Error("Browser unavailable");
    },
  });
  assert.equal((await f.controller.begin(SCOPE, INPUT)).kind, "open-failed");
  assert.deepEqual(f.record(), READY);
  assert.equal((await f.controller.begin(SCOPE, INPUT)).kind, "existing");
  assert.equal(
    opens,
    1,
    "existing checkout is not reopened by a duplicate pane",
  );
  assert.equal((await f.controller.reopen(SCOPE)).kind, "opened");
  assert.equal(
    f.calls.filter((call) => Array.isArray(call) && call[0] === "initialize")
      .length,
    1,
  );
  assert.equal(opens, 2);
});

test("a failed initial persistence prevents a payment request", async () => {
  const f = fixture({
    writeAttempt: async () => {
      throw new Error("Storage full");
    },
  });
  await assert.rejects(f.controller.begin(SCOPE, INPUT), /Storage full/);
  assert.deepEqual(f.calls, ["packs"]);
});

test("failed reference persistence leaves the initializing checkpoint and never opens a browser", async () => {
  const f = fixture();
  const save = f.dependencies.writeAttempt;
  f.dependencies.writeAttempt = async (scope, attempt) => {
    if (attempt.phase === "ready") throw new Error("Reference save failed");
    return save(scope, attempt);
  };
  await assert.rejects(
    f.controller.begin(SCOPE, INPUT),
    /Reference save failed/,
  );
  assert.equal(f.record().phase, "initializing");
  assert.equal(
    f.calls.some((call) => Array.isArray(call) && call[0] === "open"),
    false,
  );
  assert.equal(
    (await f.controller.begin(SCOPE, INPUT)).kind,
    "initialization-uncertain",
  );
});

test("duplicate panes/controllers serialize one payment initialization", async () => {
  const gate = deferred();
  const reached = deferred();
  let initializes = 0;
  const f = fixture({
    payments: {
      createTransaction: async () => {
        initializes += 1;
        reached.resolve();
        await gate.promise;
        return CHECKOUT;
      },
    },
  });
  const first = f.controller.begin(SCOPE, INPUT);
  const duplicate = f.controller.begin({ ...SCOPE }, INPUT);
  const otherController = createFirstJobCredits(f.dependencies).begin(
    SCOPE,
    INPUT,
  );
  await reached.promise;
  gate.resolve();
  assert.equal((await first).kind, "opened");
  assert.deepEqual(await duplicate, await first);
  assert.equal((await otherController).kind, "existing");
  assert.equal(initializes, 1);
});

test("paid verification with no available gateway balance does not enable work", async () => {
  const f = fixture({
    readAvailableCredits: async () => {
      f.calls.push("balance");
      return 0n;
    },
  });
  f.seed(READY);
  assert.deepEqual(await f.controller.check(SCOPE), {
    kind: "waiting",
    paid: true,
    availableNanousd: 0n,
  });
  assert.deepEqual(f.calls, [["verify", "reference-a"], "balance"]);
});

test("false verification still reads available balance; it is not a failed payment", async () => {
  const f = fixture({
    payments: { verify: async () => ({ paid: false, usdCents: 0 }) },
    readAvailableCredits: async () => 0n,
  });
  f.seed(READY);
  assert.deepEqual(await f.controller.check(SCOPE), {
    kind: "waiting",
    paid: false,
    availableNanousd: 0n,
  });
  f.dependencies.readAvailableCredits = async () => 1n;
  assert.deepEqual(await f.controller.check(SCOPE), {
    kind: "funded",
    paid: false,
    availableNanousd: 1n,
  });
  assert.deepEqual(f.record(), READY);
});

test("balance-read and verification errors stay errors and never reinitialize checkout", async () => {
  const f = fixture({
    readAvailableCredits: async () => {
      throw new Error("Balance unavailable");
    },
  });
  f.seed(READY);
  await assert.rejects(f.controller.check(SCOPE), /Balance unavailable/);
  f.dependencies.payments.verify = async () => {
    throw new Error("Verification unavailable");
  };
  await assert.rejects(f.controller.check(SCOPE), /Verification unavailable/);
  assert.deepEqual(f.record(), READY);
  assert.equal(
    f.calls.some((call) => Array.isArray(call) && call[0] === "initialize"),
    false,
  );
});

test("unknown initialization can reconcile actual funds without inventing a payment reference", async () => {
  const f = fixture({ readAvailableCredits: async () => 0n });
  f.seed({ phase: "initializing", ...INPUT });
  assert.deepEqual(await f.controller.check(SCOPE), {
    kind: "initialization-uncertain",
    availableNanousd: 0n,
  });
  f.dependencies.readAvailableCredits = async () => 2n;
  assert.deepEqual(await f.controller.check(SCOPE), {
    kind: "funded",
    paid: null,
    availableNanousd: 2n,
  });
  assert.equal(f.calls.length, 0);
});

test("scope changes after payment responses stop persistence, browser open and success claims", async () => {
  for (const step of [
    "packs",
    "createTransaction",
    "verify",
    "readAvailableCredits",
    "writeAttempt",
    "openUrl",
  ]) {
    const f = fixture();
    const host =
      step in f.dependencies.payments
        ? f.dependencies.payments
        : f.dependencies;
    const original = host[step];
    host[step] = async (...args) => {
      const result = await original(...args);
      f.stale();
      return result;
    };
    if (step === "verify" || step === "readAvailableCredits") f.seed(READY);
    const action =
      step === "verify" || step === "readAvailableCredits"
        ? f.controller.check(SCOPE)
        : f.controller.begin(SCOPE, INPUT);
    await assert.rejects(action, /Scope changed/, step);
    if (["packs", "createTransaction", "writeAttempt"].includes(step))
      assert.equal(
        f.calls.some((call) => Array.isArray(call) && call[0] === "open"),
        false,
        step,
      );
    if (step === "createTransaction")
      assert.equal(f.record().phase, "initializing");
  }
});

test("scope becomes stale while waiting for the persistence lock", async () => {
  const f = fixture({
    withAttemptLock: async (_scope, action) => {
      f.stale();
      return action();
    },
  });
  await assert.rejects(f.controller.begin(SCOPE, INPUT), /Scope changed/);
  assert.deepEqual(f.calls, []);
});

test("a saved checkout from one identity is not reused for another", async () => {
  const f = fixture();
  f.seed(READY);
  const other = { ...SCOPE, ownerPubkey: "owner-b" };
  assert.equal((await f.controller.begin(other, INPUT)).kind, "opened");
  assert.equal(
    f.calls.filter((call) => Array.isArray(call) && call[0] === "initialize")
      .length,
    1,
  );
});

test("bounded input and the actual catalogue gate payment initialization", async () => {
  for (const input of [
    { ...INPUT, packId: "missing" },
    { ...INPUT, email: "not-email" },
    { ...INPUT, email: `${"a".repeat(255)}@test.test` },
    { ...INPUT, packId: "p".repeat(257) },
  ]) {
    const f = fixture();
    await assert.rejects(f.controller.begin(SCOPE, input));
    assert.equal(
      f.calls.some((call) => Array.isArray(call)),
      false,
    );
  }
  const f = fixture({
    payments: {
      packs: async () => ({ packs: CATALOGUE.packs, currency: null }),
    },
  });
  await assert.rejects(f.controller.begin(SCOPE, INPUT), /price|available/i);
});

test("malformed saved state cannot be discarded into a second payment", async () => {
  const f = fixture();
  f.seed({
    phase: "ready",
    ...INPUT,
    reference: "reference-a",
    authorizationUrl: "javascript:alert(1)",
  });
  await assert.rejects(f.controller.begin(SCOPE, INPUT), /checkout/i);
  assert.deepEqual(f.calls, []);
});
