import assert from "node:assert/strict";
import { test } from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import {
  canonicalCompanyJson,
  COMPANY_SCHEMA,
  COMMUNITY_PROFILE_ID,
} from "@/features/company/contracts";
import {
  KIND_COMPANY_ACTION,
  KIND_COMPANY_PROFILE,
} from "@/shared/constants/kinds";
import {
  createFirstJobBusinessContext,
  firstJobBusinessRequestId,
  isFirstJobBusinessAttempt,
  isUnconfiguredFirstJobBusiness,
  validateFirstJobSuggestionRoot,
} from "./firstJobBusinessContextController.ts";
import { firstJobSuggestionTag } from "./firstJobSuggestion.ts";

const key = new Uint8Array(32).fill(7);
const owner = getPublicKey(key);
const relay = "e".repeat(64);
const requestId = "12345678-1234-5678-9234-123456789abc";
const idempotency = "12345678-1234-5678-9234-123456789abd";
const payload = {
  version: 1,
  ownerPubkey: owner,
  relayUrl: "wss://acme.test",
  channelId: "welcome",
  requestId: "first-setup",
  businessName: "Horizon Labs",
  business: "Branding for service businesses.",
  website: "https://horizon.test",
  brief: "Draft five captions.",
};
function rootFor(details = payload) {
  return finalizeEvent(
    {
      kind: 9,
      content: "Setup suggestion",
      created_at: 100,
      tags: [["h", "welcome"], firstJobSuggestionTag(details)],
    },
    key,
  );
}
const root = rootFor();
const scope = {
  ownerPubkey: owner,
  relayUrl: payload.relayUrl,
  channelId: payload.channelId,
  threadRootId: root.id,
  requestId: payload.requestId,
};
const initialProfile = {
  schema: COMPANY_SCHEMA,
  tradingName: "Acme",
  legalName: null,
  website: null,
  summary: "",
  businessType: "unspecified",
  services: [],
  customerSegments: [],
  costCentres: [
    { id: "general", name: "General", kind: "internal", serviceId: null },
  ],
  sourceReportEventId: null,
  createdAt: 100,
  updatedAt: 100,
};
const oldHead = "a".repeat(64);
const newHead = "b".repeat(64);
function signedAction(input) {
  const target = `${KIND_COMPANY_PROFILE}:${relay}:${COMMUNITY_PROFILE_ID}`;
  return finalizeEvent(
    {
      kind: KIND_COMPANY_ACTION,
      created_at: 200,
      tags: [
        ["p", relay],
        ["a", target],
        ["company-action", "1", "update", input.requestId, idempotency],
      ],
      content: canonicalCompanyJson({
        schema: "colony.company-action/v1",
        operation: "update",
        requestId: input.requestId,
        idempotencyKey: idempotency,
        target,
        expectedHead: input.expectedHeadEventId,
        expectedReferences: [],
        payload: { kind: "company", record: input.profile },
      }),
    },
    key,
  );
}
function fixture() {
  let head = { profile: structuredClone(initialProfile), headEventId: oldHead };
  let stored = null;
  let receipt = null;
  let active = true;
  let queue = Promise.resolve();
  const calls = [];
  const deps = {
    async assertCurrent() {
      if (!active) throw new Error("account changed");
    },
    async assertRoot(captured, details) {
      validateFirstJobSuggestionRoot(captured, details, rootFor(details));
    },
    withLock(_scope, work) {
      const result = queue.then(work);
      queue = result.catch(() => {});
      return result;
    },
    read: () => stored,
    write(_scope, value) {
      calls.push("persist");
      assert.ok(isFirstJobBusinessAttempt(value));
      stored = structuredClone(value);
    },
    relaySelf: async () => relay,
    loadHead: async () => structuredClone(head),
    async sign(_scope, input) {
      calls.push("sign");
      return signedAction(input);
    },
    readReceipt: async () => receipt,
    async submit(_scope, attempt) {
      calls.push("publish");
      assert.equal(
        stored.action.id,
        attempt.action.id,
        "the exact signed action must already be durable",
      );
      head = {
        profile: structuredClone(attempt.profile),
        headEventId: newHead,
      };
      receipt = {
        actionEventId: attempt.action.id,
        outcome: "applied",
        headEventId: newHead,
      };
      return { status: "applied", headEventId: newHead };
    },
    now: () => 200_000,
    requestId: async () => requestId,
    delay: async () => {},
  };
  return {
    deps,
    calls,
    run: () => createFirstJobBusinessContext(deps)(scope, payload),
    head: () => head,
    setHead: (value) => {
      head = value;
    },
    stored: () => stored,
    setStored: (value) => {
      stored = value;
    },
    setReceipt: (value) => {
      receipt = value;
    },
    leave: () => {
      active = false;
    },
  };
}

test("retains reviewed answers through a durable signed CAS and canonical readback", async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.calls, ["sign", "persist", "publish"]);
  assert.equal(f.head().profile.tradingName, payload.businessName);
  assert.equal(f.head().profile.summary, payload.business);
  assert.equal(f.head().profile.website, payload.website);
  assert.deepEqual(f.head().profile.costCentres, initialProfile.costCentres);
  await f.run();
  assert.equal(f.calls.filter((call) => call === "publish").length, 1);
});

test("configured business and manual name/budget edits survive old setup cards", async () => {
  for (const patch of [
    { summary: "Already reviewed." },
    { website: "https://existing.test" },
    { services: [{ id: "design" }] },
    { customerSegments: ["Agencies"] },
  ]) {
    const f = fixture();
    const head = {
      profile: { ...initialProfile, ...patch },
      headEventId: oldHead,
    };
    f.setHead(head);
    await f.run();
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.head(), head);
  }
  const f = fixture();
  f.setHead({
    profile: {
      ...initialProfile,
      tradingName: "Owner renamed this",
      costCentres: [
        { id: "custom", name: "My budget", kind: "internal", serviceId: null },
      ],
    },
    headEventId: oldHead,
  });
  await f.run();
  assert.equal(f.head().profile.tradingName, "Owner renamed this");
  assert.equal(f.head().profile.costCentres[0].id, "custom");
});

test("matches the core unconfigured predicate, including null versus blank website", () => {
  assert.equal(isUnconfiguredFirstJobBusiness(initialProfile), true);
  assert.equal(
    isUnconfiguredFirstJobBusiness({ ...initialProfile, summary: "  " }),
    true,
  );
  assert.equal(
    isUnconfiguredFirstJobBusiness({ ...initialProfile, website: "" }),
    false,
  );
});

test("storage failure prevents publication and stale signing cannot cross an identity switch", async () => {
  const f = fixture();
  f.deps.write = () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(f.run, /storage unavailable/);
  assert.deepEqual(f.calls, ["sign"]);
  const g = fixture();
  const sign = g.deps.sign;
  g.deps.sign = async (...args) => {
    const event = await sign(...args);
    g.leave();
    return event;
  };
  await assert.rejects(g.run, /account changed/);
  assert.deepEqual(g.calls, ["sign"]);
});

test("lost publication receipt retries the identical signed action after reload", async () => {
  const f = fixture();
  const submit = f.deps.submit;
  f.deps.submit = async () => {
    f.calls.push("uncertain");
    throw new Error("connection lost");
  };
  await assert.rejects(f.run, /connection lost/);
  const action = f.stored().action;
  f.deps.submit = async (...args) => {
    assert.deepEqual(args[1].action, action);
    return submit(...args);
  };
  await createFirstJobBusinessContext(f.deps)(scope, payload);
  assert.equal(f.calls.filter((call) => call === "sign").length, 1);
});

test("a previously applied signed receipt resolves before any republication", async () => {
  const f = fixture();
  f.deps.submit = async () => {
    throw new Error("connection lost");
  };
  await assert.rejects(f.run);
  f.setReceipt({
    outcome: "applied",
    actionEventId: f.stored().action.id,
    headEventId: newHead,
  });
  let reads = 0;
  f.deps.loadHead = async () =>
    ++reads < 2
      ? { profile: initialProfile, headEventId: oldHead }
      : { profile: f.stored().profile, headEventId: newHead };
  await f.run();
  assert.equal(f.calls.filter((call) => call === "sign").length, 1);
});

test("a concurrent configured profile wins the CAS without rebasing owner edits", async () => {
  const f = fixture();
  const winner = {
    profile: {
      ...initialProfile,
      tradingName: "New name",
      summary: "Owner's newer business.",
    },
    headEventId: "c".repeat(64),
  };
  f.deps.submit = async () => {
    f.setHead(winner);
    f.setReceipt({ outcome: "conflict", headEventId: null });
    return { status: "conflict" };
  };
  await f.run();
  assert.deepEqual(f.head(), winner);
  assert.equal(f.calls.filter((call) => call === "sign").length, 1);
});

test("concurrent windows share the attempt; an unsigned or transplanted attempt is rejected", async () => {
  const f = fixture();
  await Promise.all([f.run(), f.run()]);
  assert.deepEqual(f.calls, ["sign", "persist", "publish"]);
  const g = fixture();
  g.setStored({
    ...f.stored(),
    action: { ...f.stored().action, content: "changed" },
  });
  await assert.rejects(g.run, /does not match/);
  assert.deepEqual(g.calls, []);
  const h = fixture();
  h.setStored(f.stored());
  h.deps.requestId = async () => "another-thread";
  await assert.rejects(h.run, /another thread/);
});

test("overlong immutable cards offer Company repair and then preserve that repaired profile", async () => {
  const f = fixture();
  const details = { ...payload, business: "x".repeat(4001) };
  const captured = { ...scope, threadRootId: rootFor(details).id };
  const run = () => createFirstJobBusinessContext(f.deps)(captured, details);
  await assert.rejects(
    run,
    (error) =>
      error.code === "first-job-business-repair" &&
      /Settings → Company/.test(error.message),
  );
  assert.deepEqual(f.calls, []);
  f.setHead({
    profile: { ...initialProfile, summary: "A shorter reviewed description." },
    headEventId: newHead,
  });
  await run();
  assert.deepEqual(f.calls, []);
});

test("root authority binds owner, relay, channel, request, payload and signature", () => {
  validateFirstJobSuggestionRoot(scope, payload, root);
  for (const patch of [
    { ownerPubkey: "d".repeat(64) },
    { relayUrl: "wss://other.test" },
    { channelId: "elsewhere" },
    { requestId: "other" },
    { threadRootId: "f".repeat(64) },
  ])
    assert.throws(() =>
      validateFirstJobSuggestionRoot({ ...scope, ...patch }, payload, root),
    );
  assert.throws(() =>
    validateFirstJobSuggestionRoot(
      scope,
      { ...payload, business: "substituted" },
      root,
    ),
  );
  assert.throws(() =>
    validateFirstJobSuggestionRoot(scope, payload, {
      ...root,
      sig: "0".repeat(128),
    }),
  );
});

test("a publish success without a signed receipt cannot finish business setup", async () => {
  const f = fixture();
  f.deps.submit = async () => ({ status: "applied", headEventId: newHead });
  await assert.rejects(f.run, /awaiting confirmation/);
  assert.equal(f.stored().expectedHeadEventId, oldHead);
  assert.deepEqual(f.head().profile, initialProfile);
});

test("a still-unconfigured CAS winner offers repair instead of overwriting its budgets", async () => {
  const f = fixture();
  const winner = {
    profile: {
      ...initialProfile,
      updatedAt: 120,
      costCentres: [
        {
          id: "changed",
          name: "Owner budget",
          kind: "internal",
          serviceId: null,
        },
      ],
    },
    headEventId: "c".repeat(64),
  };
  f.deps.submit = async () => {
    f.setHead(winner);
    f.setReceipt({ outcome: "conflict", headEventId: null });
    return { status: "conflict" };
  };
  await assert.rejects(
    f.run,
    (error) => error.code === "first-job-business-repair",
  );
  assert.deepEqual(f.head(), winner);
  assert.equal(f.calls.filter((call) => call === "sign").length, 1);
});

test("canonical summary limits count Unicode characters rather than UTF-8 bytes or UTF-16 units", async () => {
  const f = fixture();
  const details = { ...payload, business: "🦋".repeat(4000) };
  const captured = { ...scope, threadRootId: rootFor(details).id };
  await createFirstJobBusinessContext(f.deps)(captured, details);
  assert.equal(f.head().profile.summary, details.business);
});

test("the business action request claim is stable and scoped to every root boundary", async () => {
  const first = await firstJobBusinessRequestId(scope);
  assert.equal(await firstJobBusinessRequestId({ ...scope }), first);
  assert.match(
    first,
    /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  for (const patch of [
    { ownerPubkey: "d".repeat(64) },
    { relayUrl: "wss://other.test" },
    { channelId: "elsewhere" },
    { requestId: "other" },
    { threadRootId: "f".repeat(64) },
  ])
    assert.notEqual(
      await firstJobBusinessRequestId({ ...scope, ...patch }),
      first,
    );
});
