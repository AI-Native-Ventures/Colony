import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalBlockJson,
  computeApprovalHash,
  containsSecretBearingField,
  createBlockActionSubmitter,
  isRetryableBlockActionTransportError,
  resolveApprovalActionInputForSubmission,
  resolveApprovalActionInputs,
  resetInFlightBlockActions,
  validateApprovalGrant,
} from "./blockActions.ts";
import {
  createBlockActionQueue,
  queueRetryableQuestionAction,
  replayQueuedQuestionActions,
  resetBlockActionQueue,
} from "./blockActionQueue.ts";

const INSTANCE = "a".repeat(64);
const MANIFEST = "b".repeat(64);
const PROCESSOR = "c".repeat(64);
const UUID = "11111111-1111-4111-8111-111111111111";

function request(overrides = {}) {
  return {
    channelId: "36411e44-0e2d-4cfe-bd6e-567eb169db9f",
    instanceEventId: INSTANCE,
    manifestId: MANIFEST,
    instanceId: UUID,
    actionId: "question.submit",
    processorPubkey: PROCESSOR,
    data: { selected: ["premium", "motion"] },
    idempotencyKey: UUID,
    ...overrides,
  };
}

test("canonical Block JSON and Approval hashing match the Rust golden vector", () => {
  const proposal = {
    action: "email.send",
    destination: "mailto:owner@example.com",
    content: { subject: "Intro", body: "Hello" },
    expires_at: 1_785_456_000,
  };
  assert.equal(
    canonicalBlockJson({ z: 1, a: { d: 4, c: 3 } }),
    '{"a":{"c":3,"d":4},"z":1}',
  );
  assert.equal(
    computeApprovalHash(proposal),
    "15c0fae0965fb074722e07e8ccaf8a431ccb9328195c8fc3682e8d0a4f77f44c",
  );
});

test("double click shares one signed action and one publish", async () => {
  let signCount = 0;
  let publishCount = 0;
  let uuidCount = 0;
  let release;
  const submit = createBlockActionSubmitter({
    randomUuid: () => {
      uuidCount += 1;
      return UUID;
    },
    sign: async (input) => {
      signCount += 1;
      return {
        id: "d".repeat(64),
        pubkey: PROCESSOR,
        kind: input.kind,
        created_at: 1,
        content: input.content,
        tags: input.tags,
        sig: "sig",
      };
    },
    publish: async (event) => {
      publishCount += 1;
      await new Promise((resolve) => {
        release = resolve;
      });
      return event;
    },
  });

  const first = submit(request({ idempotencyKey: undefined }));
  const second = submit(request({ idempotencyKey: undefined }));
  await Promise.resolve();
  assert.equal(signCount, 1);
  assert.equal(publishCount, 1);
  assert.equal(uuidCount, 1);
  release();
  assert.equal(await first, await second);
});

test("community reset cancels an action that has not reached publish", async () => {
  let releaseSign;
  let publishCount = 0;
  const submit = createBlockActionSubmitter({
    randomUuid: () => UUID,
    sign: async (input) => {
      await new Promise((resolve) => {
        releaseSign = resolve;
      });
      return {
        id: "d".repeat(64),
        pubkey: PROCESSOR,
        kind: input.kind,
        created_at: 1,
        content: input.content,
        tags: input.tags,
        sig: "sig",
      };
    },
    publish: async (event) => {
      publishCount += 1;
      return event;
    },
  });

  const pending = submit(request());
  await Promise.resolve();
  resetInFlightBlockActions();
  releaseSign();

  await assert.rejects(pending, /active community changed/);
  assert.equal(publishCount, 0);
});

test("safe actions reject secret-bearing fields at any depth", async () => {
  assert.equal(
    containsSecretBearingField({ definition: { env: { api_key: "nope" } } }),
    true,
  );
  const submit = createBlockActionSubmitter({
    randomUuid: () => UUID,
    sign: async () => {
      throw new Error("must not sign");
    },
    publish: async () => {
      throw new Error("must not publish");
    },
  });
  await assert.rejects(
    submit(request({ data: { nested: { private_key: "nope" } } })),
    /secret-bearing/,
  );
});

test("only transport failures qualify for the Question offline queue", () => {
  assert.equal(
    isRetryableBlockActionTransportError(
      new Error("Timed out while submitting the Block action."),
    ),
    true,
  );
  assert.equal(
    isRetryableBlockActionTransportError(
      new Error("Relay rejected event: permission denied"),
    ),
    false,
  );
  assert.equal(
    isRetryableBlockActionTransportError(
      new Error("Relay session is terminal; cannot reconnect."),
    ),
    false,
  );
  assert.equal(
    isRetryableBlockActionTransportError(
      new Error("Relay socket is not connected."),
    ),
    true,
  );
  assert.equal(
    isRetryableBlockActionTransportError(
      new Error("Block action cancelled because the active community changed."),
    ),
    true,
  );
});

test("Approval grant disables on mutation, hash mismatch, or expiry", () => {
  const proposal = {
    action: "email.send",
    destination: "mailto:owner@example.com",
    content: { body: "Hello" },
    expires_at: 2_000,
  };
  assert.equal(
    validateApprovalGrant({
      current: proposal,
      expected: proposal,
      nowSeconds: 1_000,
    }).ok,
    true,
  );
  assert.match(
    validateApprovalGrant({
      current: { ...proposal, destination: "other@example.com" },
      expected: proposal,
      nowSeconds: 1_000,
    }).reason,
    /changed/,
  );
  assert.match(
    validateApprovalGrant({
      current: proposal,
      expected: proposal,
      nowSeconds: 2_001,
    }).reason,
    /expired/,
  );
});

test("Approval derives only exact approve and deny payloads while pending", () => {
  const result = resolveApprovalActionInputs(
    {
      action: "email.send",
      destination: "mailto:owner@example.com",
      content: "Hello",
      expires_at: 2_000,
      status: "pending",
    },
    1_000,
  );
  assert.equal(result.ok, true);
  assert.match(
    result.inputs.get("approval.approve").approval_hash,
    /^[0-9a-f]{64}$/,
  );
  assert.deepEqual(result.inputs.get("approval.deny"), {});
  assert.equal(
    resolveApprovalActionInputs(
      {
        action: "email.send",
        destination: "mailto:owner@example.com",
        content: "Hello",
        expires_at: 999,
        status: "pending",
      },
      1_000,
    ).ok,
    false,
  );
});

test("Approval submission rechecks expiry at the signing boundary", () => {
  const approval = {
    action: "email.send",
    destination: "mailto:owner@example.com",
    content: "Hello",
    expires_at: 2_000,
    status: "pending",
  };
  assert.equal(
    resolveApprovalActionInputForSubmission(approval, "approval.approve", 1_999)
      .ok,
    true,
  );
  const expired = resolveApprovalActionInputForSubmission(
    approval,
    "approval.approve",
    2_000,
  );
  assert.equal(expired.ok, false);
  assert.match(expired.reason, /expired/);
});

test("Question queue is scoped and acknowledgement removes only the winner", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const queue = createBlockActionQueue(storage);
  const base = {
    ...request(),
    relayUrl: "wss://one.example",
    identityPubkey: PROCESSOR,
    queuedAt: 1,
  };
  queue.enqueue(base);
  queue.enqueue({
    ...base,
    relayUrl: "wss://two.example",
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(
    queue.list({
      relayUrl: "wss://one.example",
      identityPubkey: PROCESSOR,
    }).length,
    1,
  );
  queue.acknowledge({
    relayUrl: base.relayUrl,
    identityPubkey: base.identityPubkey,
    idempotencyKey: base.idempotencyKey,
  });
  assert.equal(
    queue.list({
      relayUrl: "wss://one.example",
      identityPubkey: PROCESSOR,
    }).length,
    0,
  );
  assert.equal(
    queue.list({
      relayUrl: "wss://two.example",
      identityPubkey: PROCESSOR,
    }).length,
    1,
  );
});

test("community reset preserves persisted scoped Question answers", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const queue = createBlockActionQueue(storage);
  const scope = {
    relayUrl: "wss://one.example",
    identityPubkey: PROCESSOR,
  };
  queue.enqueue({
    ...request(),
    ...scope,
    queuedAt: 1,
  });

  const previousWindow = globalThis.window;
  globalThis.window = { localStorage: storage };
  try {
    resetBlockActionQueue();
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }

  assert.equal(queue.list(scope).length, 1);
});

test("live Question click preserves its original scope during a community switch", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const originalScope = {
    relayUrl: "wss://one.example",
    identityPubkey: PROCESSOR,
  };
  const nextScope = {
    relayUrl: "wss://two.example",
    identityPubkey: "d".repeat(64),
  };
  let releaseSign;
  const submit = createBlockActionSubmitter({
    randomUuid: () => UUID,
    sign: async (input) => {
      await new Promise((resolve) => {
        releaseSign = resolve;
      });
      return {
        id: "e".repeat(64),
        pubkey: PROCESSOR,
        kind: input.kind,
        created_at: 1,
        content: input.content,
        tags: input.tags,
        sig: "sig",
      };
    },
    publish: async (event) => event,
  });
  const pending = submit(request());
  await Promise.resolve();
  resetInFlightBlockActions();
  releaseSign();

  const previousWindow = globalThis.window;
  globalThis.window = { localStorage: storage };
  try {
    await assert.rejects(pending, (error) => {
      assert.equal(
        queueRetryableQuestionAction(error, {
          ...request(),
          ...originalScope,
          queuedAt: 1,
        }),
        true,
      );
      return /active community changed/.test(error.message);
    });
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }

  const queue = createBlockActionQueue(storage);
  assert.equal(queue.list(originalScope).length, 1);
  assert.equal(queue.list(nextScope).length, 0);
});

test("active Question replay preserves the original scoped answer on switch", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const queue = createBlockActionQueue(storage);
  const scope = {
    relayUrl: "wss://one.example",
    identityPubkey: PROCESSOR,
  };
  queue.enqueue({
    ...request(),
    ...scope,
    queuedAt: 1,
  });
  let releaseSign;
  const submit = createBlockActionSubmitter({
    randomUuid: () => UUID,
    sign: async (input) => {
      await new Promise((resolve) => {
        releaseSign = resolve;
      });
      return {
        id: "e".repeat(64),
        pubkey: PROCESSOR,
        kind: input.kind,
        created_at: 1,
        content: input.content,
        tags: input.tags,
        sig: "sig",
      };
    },
    publish: async (event) => event,
  });

  const replay = replayQueuedQuestionActions(scope, submit, storage);
  await Promise.resolve();
  resetInFlightBlockActions();
  releaseSign();

  assert.equal(await replay, 0);
  assert.equal(queue.list(scope).length, 1);
});

test("Question replay acknowledges successes and preserves the first failure", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const queue = createBlockActionQueue(storage);
  const scope = {
    relayUrl: "wss://one.example",
    identityPubkey: PROCESSOR,
  };
  queue.enqueue({
    ...request(),
    ...scope,
    queuedAt: 1,
  });
  queue.enqueue({
    ...request({
      actionId: "question.second",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    }),
    ...scope,
    queuedAt: 2,
  });
  const acknowledged = await replayQueuedQuestionActions(
    scope,
    async (action) => {
      if (action.actionId === "question.second") {
        throw new Error("network offline");
      }
    },
    storage,
  );
  assert.equal(acknowledged, 1);
  assert.deepEqual(
    queue.list(scope).map((action) => action.actionId),
    ["question.second"],
  );
});

test("Question replay drops terminal failures and continues with later answers", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const queue = createBlockActionQueue(storage);
  const scope = {
    relayUrl: "wss://one.example",
    identityPubkey: PROCESSOR,
  };
  queue.enqueue({
    ...request({ actionId: "question.stale" }),
    ...scope,
    queuedAt: 1,
  });
  queue.enqueue({
    ...request({
      actionId: "question.valid",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    }),
    ...scope,
    queuedAt: 2,
  });
  const attempted = [];

  const acknowledged = await replayQueuedQuestionActions(
    scope,
    async (action) => {
      attempted.push(action.actionId);
      if (action.actionId === "question.stale") {
        throw new Error("Relay rejected event: permission denied");
      }
    },
    storage,
  );

  assert.equal(acknowledged, 1);
  assert.deepEqual(attempted, ["question.stale", "question.valid"]);
  assert.deepEqual(queue.list(scope), []);
});
