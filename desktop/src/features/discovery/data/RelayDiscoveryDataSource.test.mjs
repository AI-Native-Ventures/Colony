import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  canonicalDiscoveryJson,
  RelayDiscoveryDataSource,
} from "./RelayDiscoveryDataSource.ts";
import { mapCampaign } from "./relayDiscoveryModels.ts";

const ACTOR_SECRET = generateSecretKey();
const RELAY_SECRET = generateSecretKey();
const RELAY_PUBKEY = getPublicKey(RELAY_SECRET);
const NOW = "2026-08-02T10:00:00Z";

function harness(
  active,
  receiptSecret = RELAY_SECRET,
  credentialStatuses = {},
  workerReceiptVersion = "2",
) {
  let published = null;
  let campaign = null;
  let workerListener = null;
  let runAction = null;
  let runActions = 0;
  let run = null;
  const publishedEvents = [];
  const workerId = "1f507956-6f08-4e6a-bf38-3a7011565047";
  const lead = {
    lead_id: "b53e6fb2-2a91-45bc-a382-60feb217767a",
    campaign_id: "",
    industry_id: "automotive",
    vertical_id: "auto-repair",
    provider: "outscraper",
    name: "Sandton Auto Works",
    website: "https://sandton-auto.example",
    phone: "+27 11 555 0100",
    full_address: "1 Rivonia Road, Sandton, South Africa",
    city: "Sandton",
    state: "Gauteng",
    country: "South Africa",
    category: "Auto repair shop",
    subtypes: ["Mechanic"],
    rating_hundredths: 480,
    reviews_count: 52,
    source_url: "https://maps.example/sandton-auto",
    image_url: null,
    added_at: NOW,
  };
  const operations = [];
  return {
    operations,
    publishedEvents,
    get runActions() {
      return runActions;
    },
    dependencies: {
      delay: async () => {},
      relaySelf: async () => RELAY_PUBKEY,
      sign: async ({ kind, content, createdAt, tags }) =>
        finalizeEvent(
          {
            kind,
            content,
            created_at: createdAt ?? 1_785_665_600,
            tags,
          },
          ACTOR_SECRET,
        ),
      publish: async (event) => {
        published = event;
        publishedEvents.push(event);
        if (event.kind === 40017) {
          runActions += 1;
          runAction = event;
          const content = JSON.parse(event.content);
          run = {
            run_id: "7112c2bb-9a11-48b4-a516-7b2a7bb7f5fb",
            campaign_id: content.campaign_id,
            state: "queued",
            completed_steps: 0,
            total_steps: 4,
            cancel_requested: false,
            terminal_reason: null,
            created_at: NOW,
            updated_at: NOW,
          };
          campaign.latest_run = run;
          campaign.latest_run_sources = campaign.source_config.sources.map(
            (source, position) => ({
              source,
              provider: source === "google_maps" ? "outscraper" : source,
              position,
              status: "pending",
              request_cursor: null,
              request_count: 0,
              returned_count: 0,
              retained_count: 0,
              duplicate_count: 0,
              failure_class: null,
              started_at: null,
              finished_at: null,
              updated_at: NOW,
            }),
          );
        }
        return event;
      },
      credentialStatus: async (provider) =>
        credentialStatuses[provider] ?? "configured",
      subscribe: async (_filter, onEvent) => {
        workerListener = onEvent;
        return async () => {
          workerListener = null;
        };
      },
      fetchFirstEvent: async (filter) => {
        assert.ok(published, "an action must be published before its receipt");
        assert.deepEqual(filter["#e"], [published.id]);
        assert.deepEqual(filter["#p"], [published.pubkey]);
        if (published.kind === 40017) {
          const action = JSON.parse(published.content);
          const receipt = finalizeEvent(
            {
              kind: 40018,
              created_at: 1_785_665_601,
              tags: [
                ["p", published.pubkey],
                ["e", published.id, "", "discovery-action"],
                ["run", run.run_id],
                [
                  "discovery-receipt",
                  "2",
                  action.operation,
                  action.request_id,
                  action.idempotency_key,
                  run.run_id,
                ],
              ],
              content: canonicalDiscoveryJson({
                schema: "colony.discovery-receipt/v2",
                operation: action.operation,
                request_id: action.request_id,
                idempotency_key: action.idempotency_key,
                run,
              }),
            },
            receiptSecret,
          );
          queueMicrotask(() => {
            if (!workerListener || !runAction || !campaign) return;
            run = {
              ...run,
              state: "succeeded",
              completed_steps: 4,
              updated_at: "2026-08-02T10:00:05Z",
            };
            campaign.latest_run = run;
            campaign.lead_count = 1;
            campaign.latest_run_sources = campaign.latest_run_sources.map(
              (source, index) => ({
                ...source,
                status: index === 0 ? "completed" : "exhausted",
                request_count: 1,
                returned_count: index === 0 ? 1 : 0,
                retained_count: index === 0 ? 1 : 0,
                started_at: NOW,
                finished_at: "2026-08-02T10:00:05Z",
                updated_at: "2026-08-02T10:00:05Z",
              }),
            );
            lead.provider = campaign.latest_run_sources[0].provider;
            lead.campaign_id = campaign.campaign_id;
            workerListener(
              finalizeEvent(
                {
                  kind: 40020,
                  created_at: 1_785_665_605,
                  tags: [
                    ["p", runAction.pubkey],
                    ["e", runAction.id, "", "discovery-worker-action"],
                    ["worker", workerId],
                    [
                      "discovery-worker-receipt",
                      workerReceiptVersion,
                      "complete",
                      "4e0d1dd4-3b51-41a4-b04f-9348d34113f5",
                      "557b730a-2081-493c-9cb9-34c1388e21e0",
                      workerId,
                    ],
                  ],
                  content: canonicalDiscoveryJson({
                    schema: `colony.discovery-worker-receipt/v${workerReceiptVersion}`,
                    operation: "complete",
                    request_id: "4e0d1dd4-3b51-41a4-b04f-9348d34113f5",
                    idempotency_key: "557b730a-2081-493c-9cb9-34c1388e21e0",
                    worker_id: workerId,
                    outcome: { status: "completed", value: run },
                  }),
                },
                RELAY_SECRET,
              ),
            );
          });
          return receipt;
        }
        const action = JSON.parse(published.content);
        const request = action.request;
        const tuple = published.tags.find(
          (tag) => tag[0] === "discovery-workspace-action",
        );
        const operation = tuple[2];
        operations.push(operation);
        let result;
        if (operation === "access") {
          result = { result: "access", active };
        } else if (operation === "create_campaign") {
          const input = request.payload.campaign;
          const sourceConfig = input.source_config ?? {
            mode: "waterfall",
            sources: ["google_maps"],
          };
          campaign = {
            campaign_id: input.campaign_id,
            name: input.name,
            industry_id: input.industry_id,
            industry_name: input.industry_name,
            vertical_id: input.vertical_id,
            vertical_name: input.vertical_name,
            query: input.query,
            location: input.location,
            target: input.target,
            description: input.description,
            language: input.language,
            region: input.region,
            source_config: sourceConfig,
            lead_count: 0,
            latest_run: null,
            latest_run_sources: [],
            created_at: NOW,
            updated_at: NOW,
          };
          result = { result: "campaign", campaign };
        } else if (operation === "update_campaign_sources") {
          campaign.source_config = request.payload.source_config;
          campaign.updated_at = "2026-08-02T10:00:02Z";
          result = { result: "campaign", campaign };
        } else if (operation === "list_campaigns") {
          result = {
            result: "campaigns",
            page: {
              campaigns: campaign ? [campaign] : [],
              total: campaign ? 1 : 0,
              offset: 0,
              limit: 100,
            },
          };
        } else if (operation === "get_campaign") {
          result = { result: "campaign", campaign };
        } else {
          result = {
            result: "leads",
            page: {
              leads: campaign?.lead_count ? [lead] : [],
              total: campaign?.lead_count ? 1 : 0,
              offset: 0,
              limit: 100,
            },
          };
        }
        return finalizeEvent(
          {
            kind: 40022,
            created_at: 1_785_665_601,
            tags: [
              ["p", published.pubkey],
              ["e", published.id, "", "discovery-workspace-action"],
              [
                "discovery-workspace-receipt",
                "2",
                operation,
                request.request_id,
                request.idempotency_key,
              ],
            ],
            content: canonicalDiscoveryJson({
              schema: "colony.discovery-workspace-receipt/v2",
              receipt: {
                operation,
                request_id: request.request_id,
                idempotency_key: request.idempotency_key,
                result,
              },
            }),
          },
          receiptSecret,
        );
      },
    },
  };
}

test("canonical Discovery JSON matches the relay's sorted encoding", () => {
  assert.equal(
    canonicalDiscoveryJson({ z: 1, a: { y: true, b: null } }),
    '{"a":{"b":null,"y":true},"z":1}',
  );
});

test("a failed source remains visible without discarding another source's success", () => {
  const campaign = mapCampaign({
    campaign_id: "7112c2bb-9a11-48b4-a516-7b2a7bb7f5fb",
    name: "Mixed source result",
    industry_id: "automotive",
    industry_name: "Automotive",
    vertical_id: "auto-repair",
    vertical_name: "Auto Repair",
    query: "mechanics",
    location: "Sandton",
    target: 10,
    description: null,
    language: "en",
    region: null,
    source_config: {
      mode: "concurrent",
      sources: ["brave_search", "exa_search"],
    },
    lead_count: 3,
    latest_run: {
      run_id: "6bc3c05c-d5bc-490f-91d0-3b7ebf987cc2",
      campaign_id: "7112c2bb-9a11-48b4-a516-7b2a7bb7f5fb",
      state: "succeeded",
      completed_steps: 4,
      total_steps: 4,
      cancel_requested: false,
      terminal_reason: null,
      created_at: NOW,
      updated_at: NOW,
    },
    latest_run_sources: [
      {
        source: "brave_search",
        provider: "brave_search",
        position: 0,
        status: "failed",
        request_cursor: null,
        request_count: 1,
        returned_count: 0,
        retained_count: 0,
        duplicate_count: 0,
        failure_class: "rate_limited",
        started_at: NOW,
        finished_at: NOW,
        updated_at: NOW,
      },
      {
        source: "exa_search",
        provider: "exa_search",
        position: 1,
        status: "completed",
        request_cursor: null,
        request_count: 1,
        returned_count: 3,
        retained_count: 3,
        duplicate_count: 0,
        failure_class: null,
        started_at: NOW,
        finished_at: NOW,
        updated_at: NOW,
      },
    ],
    created_at: NOW,
    updated_at: NOW,
  });

  assert.equal(campaign.status, "partial");
  assert.equal(campaign.run.status, "partial");
  assert.match(campaign.run.sourceMetrics[0].error, /rate limit/);
  assert.equal(campaign.run.sourceMetrics[1].stored, 3);
});

test("active LAKA access switches taxonomy campaigns onto persisted relay data", async () => {
  const live = harness(true);
  const source = new RelayDiscoveryDataSource(live.dependencies);

  assert.deepEqual(await source.getEntitlement(), {
    feature: "discovery_engine",
    state: "entitled",
    planName: "LAKA",
    experience: "live",
  });
  const created = await source.createCampaign({
    name: "Sandton mechanics",
    industryId: "automotive",
    verticalId: "auto-repair",
    location: "Sandton, South Africa",
    target: 25,
  });
  assert.equal(created.name, "Sandton mechanics");
  assert.deepEqual(created.sourceConfig, {
    mode: "waterfall",
    order: ["google_maps"],
  });
  assert.equal(created.status, "ready");
  const createEvent = live.publishedEvents.find(
    (event) =>
      event.kind === 40021 &&
      JSON.parse(event.content).request.payload.operation === "create_campaign",
  );
  assert.ok(createEvent, "the workspace create action was published");
  const createContent = JSON.parse(createEvent.content);
  assert.equal(createContent.schema, "colony.discovery-workspace-action/v2");
  assert.equal(
    Object.hasOwn(createContent.request.payload.campaign, "source_config"),
    false,
    "the default source plan must be omitted to match Rust canonical JSON",
  );
  assert.equal(
    createEvent.tags.find((tag) => tag[0] === "discovery-workspace-action")[1],
    "2",
  );

  const vertical = await source.getVertical("automotive", "auto-repair");
  assert.deepEqual(
    vertical.campaigns.map(({ id }) => id),
    [created.id],
  );
  assert.equal(
    live.operations.filter((operation) => operation === "access").length,
    1,
    "the entitlement decision is cached for this community-scoped source",
  );
});

test("live campaigns persist and reload the selected source plan", async () => {
  const live = harness(true);
  const source = new RelayDiscoveryDataSource(live.dependencies);
  const created = await source.createCampaign({
    name: "Multi-source mechanics",
    industryId: "automotive",
    verticalId: "auto-repair",
    location: "Sandton, South Africa",
    target: 25,
    sourceConfig: {
      mode: "concurrent",
      order: ["brave_search", "exa_search"],
    },
  });
  assert.deepEqual(created.sourceConfig, {
    mode: "concurrent",
    order: ["brave_search", "exa_search"],
  });

  const updated = await source.updateSourceConfig(created.id, {
    mode: "waterfall",
    order: ["exa_search", "google_maps", "brave_search"],
  });
  assert.deepEqual(updated.sourceConfig, {
    mode: "waterfall",
    order: ["exa_search", "google_maps", "brave_search"],
  });
  assert.ok(live.operations.includes("update_campaign_sources"));
  const workspaceEvents = live.publishedEvents.filter((event) => {
    if (event.kind !== 40021) return false;
    const operation = JSON.parse(event.content).request.payload.operation;
    return (
      operation === "create_campaign" || operation === "update_campaign_sources"
    );
  });
  assert.deepEqual(
    JSON.parse(workspaceEvents[0].content).request.payload.campaign
      .source_config,
    { mode: "concurrent", sources: ["brave_search", "exa_search"] },
  );
  assert.deepEqual(
    JSON.parse(workspaceEvents[1].content).request.payload.source_config,
    {
      mode: "waterfall",
      sources: ["exa_search", "google_maps", "brave_search"],
    },
  );
  assert.deepEqual((await source.getCampaign(created.id)).sourceConfig, {
    mode: "waterfall",
    order: ["exa_search", "google_maps", "brave_search"],
  });
});

test("start lists every selected source whose local key is missing", async () => {
  const live = harness(true, RELAY_SECRET, {
    brave_search: "missing",
    exa_search: "missing",
  });
  const source = new RelayDiscoveryDataSource(live.dependencies);
  const campaign = await source.createCampaign({
    name: "Missing credentials",
    industryId: "automotive",
    verticalId: "auto-repair",
    location: "Sandton, South Africa",
    target: 25,
    sourceConfig: {
      mode: "concurrent",
      order: ["brave_search", "exa_search"],
    },
  });

  await assert.rejects(async () => {
    for await (const _event of source.startDiscovery(campaign.id)) {
      // The stream must fail before the run action is published.
    }
  }, /Brave Web Search, Exa Neural Search/);
  assert.equal(live.runActions, 0);
});

test("inactive workspaces stay on the cost-free demo and cannot create live records", async () => {
  const locked = harness(false);
  const source = new RelayDiscoveryDataSource(locked.dependencies);

  assert.equal((await source.getEntitlement()).experience, "demo");
  assert.ok((await source.getIndustries()).length > 0);
  const demo = await source.getCampaign("auto-repair-johannesburg");
  assert.equal(demo.id, "auto-repair-johannesburg");
  await assert.rejects(
    source.createCampaign({
      name: "Must not persist",
      industryId: "automotive",
      verticalId: "auto-repair",
      location: "Sandton",
      target: 10,
    }),
    /Activate LAKA/,
  );
  assert.deepEqual(locked.operations, ["access"]);
});

test("a receipt not signed by the tenant relay cannot grant Discovery access", async () => {
  const forged = harness(true, generateSecretKey());
  const source = new RelayDiscoveryDataSource(forged.dependencies);
  await assert.rejects(source.getEntitlement(), /signed result/);
});

test("a signed UI run follows worker progress and exposes the automatic new Lead", async () => {
  const live = harness(true);
  const source = new RelayDiscoveryDataSource(live.dependencies);
  const campaign = await source.createCampaign({
    name: "Sandton mechanics",
    industryId: "automotive",
    verticalId: "auto-repair",
    location: "Sandton, South Africa",
    target: 25,
    sourceConfig: {
      mode: "concurrent",
      order: ["brave_search", "exa_search"],
    },
  });

  const events = [];
  for await (const event of source.startDiscovery(campaign.id)) {
    events.push(event);
  }
  assert.equal(events[0].type, "session_started");
  assert.ok(
    events.some(
      (event) =>
        event.type === "source_completed" &&
        event.source === "brave_search" &&
        event.sourceMetric.stored === 1,
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "source_exhausted" && event.source === "exa_search",
    ),
  );
  assert.equal(events.at(-1).type, "session_completed");
  assert.equal(events.at(-1).partial, true);

  const page = await source.getLeads({
    scope: "campaign",
    campaignId: campaign.id,
    page: 1,
    pageSize: 25,
  });
  assert.equal(page.total, 1);
  assert.equal(page.leads[0].companyName, "Sandton Auto Works");
  assert.equal(page.leads[0].status, "new");
  assert.equal(page.leads[0].score, 0);
  assert.equal(page.leads[0].source, "brave_search");
  assert.equal(page.leads[0].sourceLabel, "Brave Web Search");
});

test("a released V1 worker receipt still wakes the V2 desktop run loop", async () => {
  const live = harness(true, RELAY_SECRET, {}, "1");
  const source = new RelayDiscoveryDataSource(live.dependencies);
  const campaign = await source.createCampaign({
    name: "Legacy worker compatibility",
    industryId: "automotive",
    verticalId: "auto-repair",
    location: "Sandton, South Africa",
    target: 25,
  });

  const events = [];
  for await (const event of source.startDiscovery(campaign.id)) {
    events.push(event);
  }
  assert.equal(events.at(-1).type, "session_completed");
});
