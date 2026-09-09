import assert from "node:assert/strict";
import test from "node:test";
import { createFirstJobSession } from "./firstJobSession.ts";
const scope = {
  ownerPubkey: "a".repeat(64),
  relayUrl: "wss://example.test",
  channelId: "welcome",
  threadRootId: "b".repeat(64),
  requestId: "req1",
};
function store(initial = null) {
  let value = initial;
  const listeners = new Set();
  return {
    read: () => value,
    write: (_scope, next) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (_scope, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
function fixture(overrides = {}) {
  const calls = [];
  const runtime = {
    scope,
    draftStore: store(),
    attemptStore: store(),
    checkoutStore: store(),
    credits: {
      loadPacks: async () => {
        calls.push("prices");
        return {
          currency: "ZAR",
          packs: [
            { id: "small", grantNanousd: "1000000000", priceZarMinor: 1000 },
          ],
        };
      },
      begin: async () => {
        calls.push("pay");
        return { kind: "initialization-uncertain" };
      },
      check: async () => {
        calls.push("credits-check");
        return { kind: "funded", paid: true, availableNanousd: 1n };
      },
      reopen: async () => {
        calls.push("reopen");
        return {
          kind: "existing",
          reference: "ref",
          authorizationUrl: "https://pay.example.test",
        };
      },
    },
    checkExistingRequest: async () => {
      calls.push("receipt");
      return null;
    },
    start: async () => {
      calls.push("start");
      return { kind: "needs-credits" };
    },
    ...overrides,
  };
  const session = createFirstJobSession(runtime, "Draft a useful first output");
  return { runtime, session, calls };
}
test("two panes share drafts and mount without starting or paying", () => {
  const f = fixture();
  let a = 0,
    b = 0;
  const removeA = f.session.subscribe(() => a++),
    removeB = f.session.subscribe(() => b++);
  f.session.edit("The same edited brief");
  assert.equal(f.runtime.draftStore.read(), "The same edited brief");
  assert.ok(a > 0 && b > 0);
  f.runtime.draftStore.write(scope, "Another window's edit");
  assert.equal(f.session.getSnapshot().brief, "Another window's edit");
  assert.deepEqual(f.calls, []);
  removeA();
  removeB();
  assert.equal(
    createFirstJobSession(f.runtime, "Original").getSnapshot().brief,
    "Another window's edit",
  );
});
test("Start checks the signed receipt before credit gates and shares concurrent clicks", async () => {
  const f = fixture();
  await Promise.all([f.session.start(), f.session.start()]);
  assert.deepEqual(f.calls, ["receipt", "start"]);
  assert.equal(f.session.getSnapshot().phase, "needs-credits");
});
test("an accepted request never asks for another payment or starts another turn", async () => {
  const f = fixture({
    checkExistingRequest: async () => ({
      eventId: "c".repeat(64),
      taskId: "task-one",
    }),
  });
  await f.session.start();
  assert.deepEqual(f.calls, []);
  assert.equal(f.session.getSnapshot().phase, "sent");
  assert.equal(f.session.getSnapshot().taskId, "task-one");
});
test("reloading prices cannot turn unknown checkout initialization into another Pay action", async () => {
  const f = fixture({
    checkoutStore: store({
      phase: "initializing",
      email: "owner@example.test",
      packId: "small",
    }),
  });
  assert.equal(f.session.getSnapshot().funding.phase, "uncertain");
  await f.session.showFunding();
  assert.equal(f.session.getSnapshot().funding.phase, "uncertain");
  assert.deepEqual(f.calls, ["prices"]);
});
test("confirmed funds only enable a separate explicit Start", async () => {
  const f = fixture();
  await f.session.start();
  await f.session.showFunding();
  await f.session.checkCredits();
  assert.equal(f.session.getSnapshot().funding.phase, "funded");
  assert.equal(f.session.getSnapshot().phase, "suggested");
  assert.deepEqual(f.calls, ["receipt", "start", "prices", "credits-check"]);
});
test("unknown sends retain the original brief and resume receipt checking", async () => {
  const attempt = {
    content: "Immutable first brief",
    message: { id: "c".repeat(64) },
    work: { taskId: "task-one" },
    acknowledged: false,
  };
  const f = fixture({ attemptStore: store(attempt) });
  assert.equal(f.session.getSnapshot().phase, "uncertain");
  f.session.edit("Changed");
  assert.equal(f.session.getSnapshot().brief, "Immutable first brief");
  await f.session.start();
  assert.deepEqual(f.calls, ["receipt", "start"]);
  assert.equal(f.session.getSnapshot().briefLocked, true);
});
test("checkout storage failure stays recoverable without an unhandled promise", async () => {
  const f = fixture();
  await f.session.showFunding();
  f.runtime.checkoutStore.read = () => {
    throw Error("saved checkout unavailable");
  };
  f.runtime.credits.begin = async () => {
    throw Error("saved checkout unavailable");
  };
  await assert.doesNotReject(f.session.pay());
  assert.equal(f.session.getSnapshot().funding.phase, "uncertain");
  assert.match(f.session.getSnapshot().funding.error, /unavailable/);
});
test("a blocked team is explicit and never reported running or complete", async () => {
  const f = fixture({
    start: async () => ({
      kind: "blocked",
      message: "Review the approved team",
    }),
  });
  await f.session.start();
  assert.equal(f.session.getSnapshot().phase, "blocked");
  assert.match(f.session.getSnapshot().error, /Review/);
  assert.equal(f.session.getSnapshot().briefLocked, false);
});

test("a funded check preserves another window's acknowledged task", async () => {
  const f = fixture();
  f.runtime.credits.check = async () => {
    f.runtime.attemptStore.write(scope, {
      content: "The accepted brief",
      acknowledged: true,
      message: { id: "c".repeat(64) },
      work: { taskId: "task-other-window" },
    });
    return { kind: "funded", paid: true, availableNanousd: 1n };
  };
  await f.session.checkCredits();
  assert.equal(f.session.getSnapshot().phase, "sent");
  assert.equal(f.session.getSnapshot().taskId, "task-other-window");
});

test("the mounted session stays shared while a real Start awaits readiness", async () => {
  const { createFirstJobSessionCache } = await import(
    "./firstJobSessionCache.ts"
  );
  let finish;
  const f = fixture({
    start: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const cache = createFirstJobSessionCache();
  const entry = cache.get("root", () => f.session);
  const release = cache.retain("root", entry);
  const started = entry.session.start();
  while (!finish) await Promise.resolve();
  release();
  const next = cache.get("root", () => fixture().session);
  assert.equal(next.session, entry.session);
  assert.equal(next.session.getSnapshot().phase, "checking");
  next.session.edit("Do not replace the in-flight brief");
  assert.equal(next.session.getSnapshot().brief, "Draft a useful first output");
  finish({ kind: "needs-credits" });
  await started;
  await Promise.resolve();
  assert.notEqual(
    cache.get("root", () => fixture().session),
    entry,
  );
});

test("a verified task refusal offers retry without presenting a lost message receipt", async () => {
  const { FirstJobTaskRefused } = await import("./firstJobDispatch.ts");
  const f = fixture({
    attemptStore: store({
      content: "Immutable refused brief",
      action: null,
      work: null,
      message: null,
      acknowledged: false,
    }),
    start: async () => {
      throw new FirstJobTaskRefused("c".repeat(64));
    },
  });
  await f.session.start();
  assert.equal(f.session.getSnapshot().phase, "error");
  assert.equal(f.session.getSnapshot().briefLocked, true);
  assert.match(f.session.getSnapshot().error, /refused before work started/);
});

test("native string errors preserve the actionable gateway failure", async () => {
  const f = fixture({
    start: async () => {
      throw "Colony Credits gateway is unavailable on this relay";
    },
  });
  await f.session.start();
  assert.match(
    f.session.getSnapshot().error,
    /Colony Credits gateway is unavailable/,
  );
  assert.notEqual(f.session.getSnapshot().phase, "sent");
});
