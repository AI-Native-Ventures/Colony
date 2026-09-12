// Drive the real choice-first Scout conversation before the fixture's explicit
// legacy first-job lane. All writes still go through the renderer/native APIs.
import assert from "node:assert/strict";
import { verifyEvent } from "nostr-tools/pure";
import { expect } from "@playwright/test";
import { FIRST_JOB_BRIEF, SCOUT_SETUP_REPLY } from "./provider.mjs";

const SCOUT_ROOT_MARKER = "colony:scout-onboarding-root:v1";
const LEGACY_SUPPRESSION_MARKER = "colony:first-job-suggestion:v1";
const SETUP_ACK_MARKER = "colony:scout-onboarding-approval:v1";
const LEGACY_START_MARKER = "colony:first-job-start:v1";
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function exactTag(event, name, predicate = () => true) {
  const matches = event.tags.filter((tag) => tag[0] === name && predicate(tag));
  assert.equal(matches.length, 1, `Exactly one ${name} tag`);
  return matches[0];
}

function signed(event, kind, pubkey) {
  assert.equal(event.kind, kind);
  assert.equal(event.pubkey, pubkey);
  assert.ok(verifyEvent(event), `Signed kind ${kind} event verifies`);
  return event;
}

function firstJobPayload({ ownerPubkey, relayUrl, channelId, requestId }) {
  return {
    version: 1,
    ownerPubkey,
    relayUrl,
    channelId,
    requestId,
    businessName: "Horizon Labs",
    business:
      "We build websites and manage social media for small service businesses.",
    website: "",
    brief: FIRST_JOB_BRIEF,
  };
}

function firstJobBody(payload) {
  return [
    "**Setup suggestion**",
    payload.businessName,
    payload.business,
    payload.website ? `Website: ${payload.website}` : "",
    `**Suggested first job**\n${payload.brief}`,
    "Scout coordinates the work and brings the result back to this thread. You can edit this suggestion. Nothing starts until you choose Start.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function readEvent(page, invoke, eventId) {
  assert.match(eventId, HEX_64);
  return JSON.parse(await invoke(page, "get_event", { eventId }));
}

function countQuery(host, expression) {
  const where = `community_id=(SELECT id FROM communities WHERE host='${host}')`;
  return `SELECT count(*) FROM events WHERE ${where} AND ${expression};`;
}

function tagQuery(marker, exactLength = 3) {
  return `EXISTS (SELECT 1 FROM jsonb_array_elements(tags) tag WHERE jsonb_array_length(tag)=${exactLength} AND tag->>0='client' AND tag->>1='${marker}')`;
}

function stableRecord(value) {
  if (Array.isArray(value)) return value.map(stableRecord);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableRecord(nested)]),
    );
  }
  return value;
}

function stableRecords(records, key) {
  return records
    .map(stableRecord)
    .sort((left, right) =>
      String(left[key] ?? "").localeCompare(String(right[key] ?? "")),
    );
}

async function readRelaySetupRecords(relay, host) {
  const where = `community_id=(SELECT id FROM communities WHERE host='${host}')`;
  const raw = await relay.query(
    `SELECT coalesce(json_agg(e ORDER BY e.kind,e.created_at,e.id),'[]')::text FROM (SELECT kind,encode(id,'hex') AS id,encode(pubkey,'hex') AS pubkey,extract(epoch FROM created_at)::bigint AS created_at FROM events WHERE ${where} AND deleted_at IS NULL AND kind IN (0,30175,30176,30177,30179,30190,39002,40013,40014,40100)) e;`,
  );
  return stableRecords(JSON.parse(raw), "id");
}

async function readSetupRecords({
  page,
  invoke,
  relay,
  communityHost,
  channelId,
}) {
  const [agents, personas, teams, membership, canvas, relayEvents] =
    await Promise.all([
      invoke(page, "list_managed_agents"),
      invoke(page, "list_personas"),
      invoke(page, "list_teams"),
      invoke(page, "get_channel_members", { channelId }),
      invoke(page, "get_canvas", { channelId }),
      readRelaySetupRecords(relay, communityHost),
    ]);
  assert.ok(Array.isArray(agents), "Managed-agent snapshot is an array");
  assert.ok(Array.isArray(personas), "Persona snapshot is an array");
  assert.ok(Array.isArray(teams), "Team snapshot is an array");
  assert.ok(
    membership && Array.isArray(membership.members),
    "Channel-members snapshot has members",
  );
  return {
    agents: stableRecords(agents, "pubkey"),
    personas: stableRecords(personas, "id"),
    teams: stableRecords(teams, "id"),
    members: stableRecords(membership.members, "pubkey"),
    canvas: stableRecord(canvas),
    relayEvents,
  };
}

async function assertSetupRecordsUnchanged({
  baseline,
  page,
  invoke,
  relay,
  communityHost,
  channelId,
  label,
}) {
  const current = await readSetupRecords({
    page,
    invoke,
    relay,
    communityHost,
    channelId,
  });
  assert.deepEqual(
    current,
    baseline,
    `${label}: no native setup record changed before approval`,
  );
}

async function assertNoBusinessWork(relay, host) {
  assert.equal(
    await relay.query(countQuery(host, "kind=30181")),
    "0",
    "No Task exists before the explicit first-job approval",
  );
  assert.equal(
    await relay.query(
      countQuery(host, `kind=9 AND ${tagQuery(LEGACY_START_MARKER)}`),
    ),
    "0",
    "No first-job instruction exists before the explicit first-job approval",
  );
  assert.equal(
    await relay.query(
      countQuery(host, `kind=9 AND ${tagQuery(LEGACY_SUPPRESSION_MARKER)}`),
    ),
    "0",
    "Choice-first onboarding has no legacy suggestion payload yet",
  );
}

async function assertSingleScoutSetupProof({
  relay,
  host,
  onboardingRootEventId,
  acknowledgementEventId,
  scoutPubkey,
}) {
  assert.equal(
    await relay.query(
      countQuery(host, `kind=9 AND ${tagQuery(SCOUT_ROOT_MARKER)}`),
    ),
    "1",
    "Reload keeps one signed Scout onboarding root",
  );
  assert.equal(
    await relay.query(
      countQuery(host, `kind=9 AND ${tagQuery(SETUP_ACK_MARKER)}`),
    ),
    "1",
    "Reload does not publish a duplicate setup acknowledgment",
  );
  assert.equal(
    await relay.query(
      countQuery(
        host,
        `kind=9 AND pubkey=decode('${scoutPubkey}','hex') AND EXISTS (SELECT 1 FROM jsonb_array_elements(tags) tag WHERE jsonb_array_length(tag)>=2 AND tag->>0='e' AND tag->>1='${acknowledgementEventId}')`,
      ),
    ),
    "1",
    `Reload keeps one Scout reply for onboarding root ${onboardingRootEventId}`,
  );
}

async function assertSetupRecords({
  page,
  invoke,
  provider,
  onboardingRootEventId,
  channelId,
  ownerPubkey,
  relayUrl,
}) {
  const setup = provider.scoutSetup;
  assert.ok(setup?.completed, "Scout setup model turn completed");
  assert.match(setup.ackEventId ?? "", HEX_64);
  assert.match(setup.replyEventId ?? "", HEX_64);
  assert.notEqual(setup.ackEventId, onboardingRootEventId);
  const agents = await invoke(page, "list_managed_agents");
  assert.equal(agents.length, 1, "Setup keeps one starter Scout");
  const scout = agents[0];
  assert.equal(scout.persona_id, "builtin:fizz");
  assert.equal(scout.relay_url, relayUrl);
  assert.ok(Number(scout.pid) > 0, "Scout is running after approved setup");

  const acknowledgement = signed(
    await readEvent(page, invoke, setup.ackEventId),
    9,
    ownerPubkey,
  );
  assert.deepEqual(
    acknowledgement.tags.filter((tag) => tag[0] === "h"),
    [["h", channelId]],
  );
  assert.deepEqual(
    acknowledgement.tags.filter(
      (tag) => tag[0] === "e" && tag[1] === onboardingRootEventId,
    ).length,
    1,
  );
  assert.deepEqual(
    acknowledgement.tags.filter(
      (tag) => tag[0] === "p" && tag[1] === scout.pubkey,
    ).length,
    1,
  );
  const ackTag = exactTag(
    acknowledgement,
    "client",
    (tag) => tag[1] === SETUP_ACK_MARKER,
  );
  assert.equal(ackTag.length, 3);
  const ackPayload = JSON.parse(ackTag[2]);
  assert.equal(ackPayload.version, 1);
  assert.match(ackPayload.requestId ?? "", UUID);
  assert.ok(ackPayload.input && typeof ackPayload.input === "object");

  const reply = signed(
    await readEvent(page, invoke, setup.replyEventId),
    9,
    scout.pubkey,
  );
  assert.equal(reply.content, SCOUT_SETUP_REPLY);
  assert.deepEqual(
    reply.tags.filter((tag) => tag[0] === "h"),
    [["h", channelId]],
  );
  assert.ok(
    reply.tags.some((tag) => tag[0] === "e" && tag[1] === setup.ackEventId),
    "Scout reply points at the signed acknowledgment",
  );
  const rootReferences = reply.tags.filter(
    (tag) => tag[0] === "e" && tag[3] === "root",
  );
  assert.ok(
    rootReferences.every((tag) => tag[1] === onboardingRootEventId),
    "Scout reply stays in the onboarding root thread",
  );
  return {
    acknowledgement,
    acknowledgementEventId: acknowledgement.id,
    ackPayload,
    reply,
    replyEventId: reply.id,
    scout,
    setupModelCalls: provider.setupRequests.length,
  };
}

/** Complete the owner-confirmed setup and return its signed records. */
export async function completeFixtureScoutSetup({
  page,
  invoke,
  relay,
  provider,
  communityHost,
  onboardingRootEventId,
  onboardingRootEvent,
  channelId,
  ownerPubkey,
  relayUrl,
  beforeSetupCalls,
  proofDirectory,
  screenshot,
}) {
  assert.equal(onboardingRootEvent.id, onboardingRootEventId);
  assert.equal(onboardingRootEvent.kind, 9);
  assert.equal(onboardingRootEvent.pubkey, ownerPubkey);
  assert.ok(verifyEvent(onboardingRootEvent));
  assert.deepEqual(
    onboardingRootEvent.tags.filter((tag) => tag[0] === "h"),
    [["h", channelId]],
  );
  const rootPayloadTag = exactTag(
    onboardingRootEvent,
    "client",
    (tag) => tag[1] === SCOUT_ROOT_MARKER,
  );
  assert.equal(rootPayloadTag.length, 3);
  const rootPayload = JSON.parse(rootPayloadTag[2]);
  assert.equal(rootPayload.ownerPubkey, ownerPubkey);
  assert.equal(rootPayload.channelId, channelId);
  assert.ok(SAFE_ID.test(rootPayload.requestId));
  const suppression = exactTag(
    onboardingRootEvent,
    "client",
    (tag) => tag[1] === LEGACY_SUPPRESSION_MARKER,
  );
  assert.equal(suppression.length, 2, "Legacy suppression stays non-payload");
  await assertNoBusinessWork(relay, communityHost);

  const conversation = page
    .locator('section[aria-label="Scout onboarding conversation"]')
    .last();
  await conversation.waitFor({ state: "visible", timeout: 90_000 });
  await expect(page.getByTestId("first-job-suggestion")).toHaveCount(0);
  assert.equal(
    provider.receivedCallCount,
    beforeSetupCalls,
    "No setup model call occurs before owner confirmation",
  );
  const preApprovalSetupRecords = await readSetupRecords({
    page,
    invoke,
    relay,
    communityHost,
    channelId,
  });
  await assertSetupRecordsUnchanged({
    baseline: preApprovalSetupRecords,
    page,
    invoke,
    relay,
    communityHost,
    channelId,
    label: "Before route intake",
  });

  await conversation.getByTestId("scout-route-existing").click();
  await conversation
    .getByRole("button", { name: "Yes, this is the business", exact: true })
    .click();
  await conversation
    .getByRole("button", { name: "Continue to priorities", exact: true })
    .click();
  await conversation
    .getByRole("button", { name: /^Get more customers/ })
    .click();
  await conversation
    .getByRole("button", { name: "Review the understanding", exact: true })
    .click();
  await conversation
    .getByRole("button", { name: "This looks right", exact: true })
    .click();
  await assertSetupRecordsUnchanged({
    baseline: preApprovalSetupRecords,
    page,
    invoke,
    relay,
    communityHost,
    channelId,
    label: "After route and understanding selection",
  });
  await conversation
    .getByLabel("Workspace context name", { exact: true })
    .fill("Horizon Labs");
  await conversation
    .getByLabel("Context Scout carries", { exact: true })
    .fill(rootPayload.seed.businessDescription);
  await assertSetupRecordsUnchanged({
    baseline: preApprovalSetupRecords,
    page,
    invoke,
    relay,
    communityHost,
    channelId,
    label: "After edited understanding",
  });
  await assertNoBusinessWork(relay, communityHost);
  assert.equal(
    provider.receivedCallCount,
    beforeSetupCalls,
    "Route intake remains free of model work before setup approval",
  );

  provider.authorizeScoutSetup({
    rootId: onboardingRootEventId,
    channelId,
  });
  await conversation
    .getByRole("button", { name: "Approve this workspace setup", exact: true })
    .click();
  await expect(
    conversation.getByRole("heading", {
      name: "Ready for the next conversation.",
      exact: true,
    }),
  ).toBeVisible({ timeout: 180_000 });
  provider.assertHealthy();
  const setup = await assertSetupRecords({
    page,
    invoke,
    provider,
    onboardingRootEventId,
    channelId,
    ownerPubkey,
    relayUrl,
  });
  assert.equal(setup.ackPayload.input.setupName, "Horizon Labs");
  assert.equal(
    setup.ackPayload.input.setupDescription,
    rootPayload.seed.businessDescription,
    "The signed setup acknowledgment preserves the edited business context",
  );
  await assertNoBusinessWork(relay, communityHost);
  assert.equal(
    provider.requests.filter((request) =>
      ["delegate", "worker", "review"].includes(request.stage),
    ).length,
    0,
    "Scout setup does not dispatch a business job",
  );
  const approvedRelaySetupRecords = await readRelaySetupRecords(
    relay,
    communityHost,
  );
  if (screenshot) await screenshot(proofDirectory, "joined-scout-ready.png");

  const callsBeforeCompletedReload = provider.receivedCallCount;
  await page.reload({ timeout: 180_000 });
  await page.waitForFunction(() => !!window.colonyDesktop, undefined, {
    timeout: 60_000,
  });
  assert.equal(
    (await invoke(page, "get_identity")).pubkey,
    ownerPubkey,
    "Completed onboarding reload keeps the owner identity",
  );
  assert.equal(
    await invoke(page, "get_relay_ws_url"),
    relayUrl,
    "Completed onboarding reload keeps the workspace relay",
  );
  const reloadedConversation = page
    .locator('section[aria-label="Scout onboarding conversation"]')
    .last();
  await reloadedConversation.waitFor({ state: "visible", timeout: 90_000 });
  await expect(
    reloadedConversation.getByRole("heading", {
      name: "Ready for the next conversation.",
      exact: true,
    }),
  ).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("first-job-suggestion")).toHaveCount(0);
  assert.equal(
    provider.receivedCallCount,
    callsBeforeCompletedReload,
    "Completed onboarding reload does not replay setup model work",
  );
  const reloadedSetup = await assertSetupRecords({
    page,
    invoke,
    provider,
    onboardingRootEventId,
    channelId,
    ownerPubkey,
    relayUrl,
  });
  assert.equal(
    reloadedSetup.scout.pubkey,
    setup.scout.pubkey,
    "Completed onboarding reload keeps the same Scout managed identity",
  );
  assert.equal(
    reloadedSetup.acknowledgementEventId,
    setup.acknowledgementEventId,
    "Completed onboarding reload keeps the same signed acknowledgment",
  );
  assert.equal(
    reloadedSetup.replyEventId,
    setup.replyEventId,
    "Completed onboarding reload keeps the same Scout reply",
  );
  const liveRuntimes = await invoke(page, "list_managed_agent_runtimes");
  const currentScoutRuntimes = liveRuntimes.filter(
    (runtime) =>
      runtime.pubkey === setup.scout.pubkey && runtime.relayUrl === relayUrl,
  );
  assert.equal(
    currentScoutRuntimes.length,
    1,
    "Completed onboarding reload finds exactly the current Scout runtime",
  );
  const [currentScoutRuntime] = currentScoutRuntimes;
  assert.ok(
    ["starting", "listening", "waking", "ready"].includes(
      currentScoutRuntime.lifecycle,
    ),
    `Current Scout runtime is live (${currentScoutRuntime.lifecycle})`,
  );
  assert.equal(currentScoutRuntime.error, null);
  assert.ok(
    Number(currentScoutRuntime.pid) > 0,
    "Completed onboarding reload keeps a live Scout process",
  );
  await assertNoBusinessWork(relay, communityHost);
  await assertSingleScoutSetupProof({
    relay,
    host: communityHost,
    onboardingRootEventId,
    acknowledgementEventId: setup.acknowledgementEventId,
    scoutPubkey: setup.scout.pubkey,
  });
  assert.deepEqual(
    await readRelaySetupRecords(relay, communityHost),
    approvedRelaySetupRecords,
    "Completed onboarding reload publishes no duplicate setup records",
  );

  return {
    onboardingRootEventId,
    onboardingRootEvent,
    onboardingPayload: rootPayload,
    ...setup,
    preLegacyModelCalls: provider.receivedCallCount,
  };
}

/** Send a distinct owner-requested v1 suggestion after Scout setup is ready. */
export async function sendExplicitLegacyFirstJob({
  page,
  invoke,
  provider,
  channelId,
  ownerPubkey,
  relayUrl,
  preLegacyModelCalls,
}) {
  const requestId = "fixture-legacy-first-job-v1";
  const suggestion = firstJobPayload({
    ownerPubkey,
    relayUrl,
    channelId,
    requestId,
  });
  const response = await invoke(page, "send_channel_message", {
    channelId,
    content: firstJobBody(suggestion),
    parentEventId: null,
    mediaTags: null,
    emojiTags: null,
    mentionTags: null,
    blockReferenceTags: null,
    clientTags: [
      ["client", "colony-onboarding-v2:first-task:fixture-legacy-root-v1"],
      ["client", LEGACY_SUPPRESSION_MARKER, JSON.stringify(suggestion)],
    ],
    linkPreviewTags: null,
    workTags: null,
    replyModelTags: null,
    sentFromThreadTag: null,
    mentionPubkeys: null,
    kind: 9,
  });
  const rootEventId = response.event_id ?? response.eventId;
  assert.match(rootEventId ?? "", HEX_64);
  assert.equal(
    provider.receivedCallCount,
    preLegacyModelCalls,
    "Posting the explicit legacy root does not start a model turn",
  );
  const rootEvent = signed(
    await readEvent(page, invoke, rootEventId),
    9,
    ownerPubkey,
  );
  assert.deepEqual(
    rootEvent.tags.filter((tag) => tag[0] === "h"),
    [["h", channelId]],
  );
  assert.equal(
    rootEvent.tags.some((tag) => tag[0] === "e"),
    false,
  );
  const legacyTag = exactTag(
    rootEvent,
    "client",
    (tag) => tag[1] === LEGACY_SUPPRESSION_MARKER,
  );
  assert.equal(legacyTag.length, 3);
  assert.deepEqual(JSON.parse(legacyTag[2]), suggestion);
  await page.evaluate(
    (channelAndEvent) => {
      const { channelId: channel, eventId } = channelAndEvent;
      location.hash = `/channels/${encodeURIComponent(channel)}?thread=${eventId}&threadRootId=${eventId}&messageId=${eventId}`;
    },
    { channelId, eventId: rootEventId },
  );
  await page
    .getByTestId("first-job-suggestion")
    .last()
    .waitFor({ state: "visible", timeout: 60_000 });
  return { rootEventId, rootEvent, suggestion };
}
