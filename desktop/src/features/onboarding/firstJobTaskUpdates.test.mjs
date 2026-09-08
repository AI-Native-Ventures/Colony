import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { canonicalCompanyJson, parseTaskHead } from "../company/contracts.ts";
import { createFirstJobTaskUpdates } from "./firstJobTaskUpdates.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
after(() => dom.window.close());

const key = (last) => Uint8Array.from([...Array(31).fill(0), last]);
const RELAY = getPublicKey(key(2));
const SCOPE = {
  ownerPubkey: getPublicKey(key(1)),
  relayUrl: "wss://business.test",
  communityId: "business",
  channelId: "welcome",
  threadRootId: "b".repeat(64),
  requestId: "first-job",
  taskId: "task-one",
};

const TASK = {
  schema: "colony.task/v1",
  id: SCOPE.taskId,
  initiativeId: "first-job-initiative",
  title: "Prepare the first social post",
  status: "completed",
  owningTeamId: "first-job-team",
  assigneePersonaIds: ["scout-persona"],
  qaPersonaId: "scout-persona",
  reviewerTeamId: null,
  costCentreId: "cc-internal",
  commercialPurpose: "marketing",
  clientOrganizationId: null,
  sourceChannelId: SCOPE.channelId,
  sourceEventId: SCOPE.threadRootId,
  implicit: false,
  dependsOn: [],
  subject: null,
  stage: null,
  threadRoot: SCOPE.threadRootId,
  doerKind: "agent",
  wakeAt: null,
  outcomeReason: null,
  bounceReason: null,
  bounceCount: 0,
  createdAt: 100,
  updatedAt: 101,
};

function head({
  author = 2,
  taskId = SCOPE.taskId,
  kind = 30181,
  at = 100,
} = {}) {
  return finalizeEvent(
    {
      kind,
      created_at: at,
      tags: [
        ["d", taskId],
        ["team", TASK.owningTeamId],
        ["initiative", TASK.initiativeId],
        ["cost-centre", TASK.costCentreId],
      ],
      content: canonicalCompanyJson({ ...TASK, id: taskId }),
    },
    key(author),
  );
}

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture({ pending, invalidate, subscribe } = {}) {
  const subscriptions = [];
  const invalidations = [];
  const scheduled = [];
  let current = true;
  let closes = 0;
  const deps = {
    assertCurrent: async () => {
      if (!current) throw new Error("scope changed");
    },
    relaySelf: async () => RELAY,
    subscribe: async (filter, onEvent, onReady) => {
      subscriptions.push({ filter, onEvent, onReady });
      await subscribe?.({
        filter,
        onEvent,
        onReady,
        attempt: subscriptions.length,
      });
      if (pending) await pending.promise;
      return async () => {
        closes += 1;
      };
    },
    invalidate: async (scope) => {
      invalidations.push(scope);
      await invalidate?.(scope);
    },
    schedule: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      scheduled.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return {
    deps,
    updates: createFirstJobTaskUpdates(deps),
    subscriptions,
    invalidations,
    scheduled,
    closes: () => closes,
    stale: () => {
      current = false;
    },
  };
}

test("two mounted task panes show canonical completion without remounting and share one subscription", async (t) => {
  assert.equal(
    parseTaskHead(head(), RELAY).ok,
    true,
    "the event fixture must satisfy the real canonical trust parser",
  );
  let status = "inProgress";
  let reads = 0;
  t.mock.module("@/features/company/companyRepository", {
    namedExports: {
      companyRepository: {
        getTask: async (taskId) => {
          reads += 1;
          assert.equal(taskId, SCOPE.taskId);
          return { ok: true, value: { ...TASK, id: taskId, status } };
        },
      },
    },
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { useTask, taskQueryKey } = await import("../company/hooks.ts");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const f = fixture({
    invalidate: (scope) =>
      queryClient.invalidateQueries({
        queryKey: taskQueryKey(scope.communityId, scope.taskId),
        exact: true,
      }),
  });
  let mounts = 0;
  function Pane() {
    const query = useTask(SCOPE.communityId, SCOPE.taskId);
    React.useEffect(() => {
      mounts += 1;
      return f.updates.retain(SCOPE);
    }, []);
    return React.createElement(
      "output",
      null,
      query.data?.ok
        ? query.data.value.status === "completed"
          ? "Completed"
          : "Working"
        : "Loading",
    );
  }
  const containers = [
    document.createElement("div"),
    document.createElement("div"),
  ];
  const roots = containers.map((container) => createRoot(container));
  const mounted = new Set(roots);
  t.after(async () => {
    await React.act(async () => {
      for (const root of mounted) root.unmount();
      await flush();
    });
    queryClient.clear();
  });
  await React.act(async () => {
    for (const root of roots)
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Pane),
        ),
      );
    await flush();
  });
  await React.act(flush);
  assert.deepEqual(
    containers.map((container) => container.textContent),
    ["Working", "Working"],
  );
  assert.equal(f.subscriptions.length, 1);
  assert.deepEqual(f.subscriptions[0].filter, {
    kinds: [30181],
    authors: [RELAY],
    "#d": [SCOPE.taskId],
    limit: 1,
  });
  const before = reads;
  status = "completed";
  await React.act(async () => {
    f.subscriptions[0].onEvent(head());
    await flush();
  });
  await React.act(flush);
  assert.deepEqual(
    containers.map((container) => container.textContent),
    ["Completed", "Completed"],
  );
  assert.equal(mounts, 2, "completion must not rely on remount or navigation");
  assert.ok(
    reads > before,
    "the signed head invalidates canonical data instead of replacing it",
  );
  await React.act(async () => {
    roots[0].unmount();
    mounted.delete(roots[0]);
    await flush();
  });
  assert.equal(f.closes(), 0);
  await React.act(async () => {
    roots[1].unmount();
    mounted.delete(roots[1]);
    await flush();
  });
  assert.equal(f.closes(), 1);
});

test("wrong signer, task, kind and forged signatures never invalidate a mounted task", async () => {
  const f = fixture();
  const release = f.updates.retain(SCOPE);
  try {
    await flush();
    assert.equal(f.subscriptions.length, 1);
    const before = f.invalidations.length;
    for (const event of [
      head({ author: 3 }),
      head({ taskId: "other-task" }),
      head({ kind: 9 }),
      { ...head(), content: "forged after signature verification" },
    ]) {
      f.subscriptions[0].onEvent(event);
      await flush();
    }
    assert.equal(f.invalidations.length, before);
    f.subscriptions[0].onEvent(head({ at: 101 }));
    await flush();
    assert.equal(f.invalidations.length, before + 1);
  } finally {
    release();
    await flush();
  }
});

test("releasing the last reader while subscribe is pending closes the late subscription and ignores callbacks", async () => {
  const pending = deferred();
  const f = fixture({ pending });
  const release = f.updates.retain(SCOPE);
  await flush();
  assert.equal(f.subscriptions.length, 1);
  const before = f.invalidations.length;
  release();
  pending.resolve();
  await flush();
  f.subscriptions[0].onReady();
  f.subscriptions[0].onEvent(head());
  await flush();
  assert.equal(f.closes(), 1);
  assert.equal(f.invalidations.length, before);
});

test("a scope change during pending subscribe cannot invalidate the next account or business", async () => {
  const pending = deferred();
  const f = fixture({ pending });
  const release = f.updates.retain(SCOPE);
  try {
    await flush();
    assert.equal(f.subscriptions.length, 1);
    const before = f.invalidations.length;
    f.stale();
    pending.resolve();
    await flush();
    f.subscriptions[0].onReady();
    f.subscriptions[0].onEvent(head());
    await flush();
    assert.equal(f.invalidations.length, before);
  } finally {
    release();
    await flush();
  }
});

test("initial subscription failures retry once while mounted and cancel retry after the final release", async () => {
  const f = fixture({
    subscribe: async ({ attempt }) => {
      if (attempt === 1) throw new Error("temporarily offline");
    },
  });
  const release = f.updates.retain(SCOPE);
  try {
    await flush();
    assert.equal(f.subscriptions.length, 1);
    assert.equal(f.scheduled.length, 1);
    assert.ok(f.scheduled[0].delay > 0);
    f.subscriptions[0].onReady();
    f.subscriptions[0].onEvent(head());
    await flush();
    assert.equal(
      f.invalidations.length,
      0,
      "callbacks from the failed connection must stop before retry",
    );
    f.scheduled[0].callback();
    await flush();
    assert.equal(f.subscriptions.length, 2);
    f.subscriptions[1].onReady();
    await flush();
    assert.equal(f.invalidations.length, 1);
  } finally {
    release();
    await flush();
  }
  assert.equal(f.closes(), 1);

  const failed = fixture({
    subscribe: async () => {
      throw new Error("offline");
    },
  });
  const releaseFailed = failed.updates.retain(SCOPE);
  await flush();
  assert.equal(failed.scheduled.length, 1);
  releaseFailed();
  assert.equal(failed.scheduled[0].cancelled, true);
  failed.scheduled[0].callback();
  await flush();
  assert.equal(
    failed.subscriptions.length,
    1,
    "even a racing cancelled timer cannot reconnect an unmounted task",
  );
});

test("a new signed head during a canonical reread triggers another reread", async () => {
  const pending = deferred();
  const f = fixture({
    invalidate: async () => {
      await pending.promise;
    },
  });
  const release = f.updates.retain(SCOPE);
  try {
    await flush();
    f.subscriptions[0].onEvent(head());
    await flush();
    assert.equal(f.invalidations.length, 1);
    f.subscriptions[0].onEvent(head({ at: 101 }));
    await flush();
    assert.equal(f.invalidations.length, 1, "concurrent reads are coalesced");
    pending.resolve();
    await flush();
    assert.equal(
      f.invalidations.length,
      2,
      "the event arriving during the old read must not be lost",
    );
  } finally {
    pending.resolve();
    release();
    await flush();
  }
});

test("reconnected readiness cannot lose a completion while an earlier generation still refreshes", async () => {
  const pending = deferred();
  const f = fixture({
    invalidate: async () => {
      await pending.promise;
    },
    subscribe: async ({ attempt, onReady }) => {
      onReady();
      if (attempt === 1) throw new Error("subscription lost after readiness");
    },
  });
  const release = f.updates.retain(SCOPE);
  try {
    await flush();
    assert.equal(f.invalidations.length, 1);
    assert.equal(f.scheduled.length, 1);
    f.scheduled[0].callback();
    await flush();
    assert.equal(f.subscriptions.length, 2);
    f.subscriptions[1].onEvent(head());
    await flush();
    pending.resolve();
    await flush();
    assert.equal(
      f.invalidations.length,
      2,
      "new-generation readiness must survive the old read settling",
    );
  } finally {
    pending.resolve();
    release();
    await flush();
  }
});
