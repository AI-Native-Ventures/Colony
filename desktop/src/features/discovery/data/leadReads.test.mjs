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

const ACTOR_SECRET = generateSecretKey();
const RELAY_SECRET = generateSecretKey();
const RELAY_PUBKEY = getPublicKey(RELAY_SECRET);

function leadRow(index) {
  return {
    lead_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    campaign_id: "",
    industry_id: "automotive",
    vertical_id: "auto-repair",
    provider: "outscraper",
    name: `Lead ${index}`,
    website: null,
    phone: null,
    full_address: "1 Rivonia Road, Sandton, South Africa",
    city: "Sandton",
    state: "Gauteng",
    country: "South Africa",
    category: "Auto repair shop",
    subtypes: [],
    rating_hundredths: 400,
    reviews_count: 1,
    source_url: null,
    image_url: null,
    added_at: "2026-08-02T10:00:00Z",
    status: "candidate",
  };
}

/**
 * A relay that answers workspace reads and records how they were issued.
 *
 * `operations` is the ordered list of operations that reached the relay, and
 * `peakConcurrency` is the largest number of reads that were in flight at the
 * same moment. Together they say both how many round trips a screen costs and
 * whether those trips were serialised.
 */
function relay({ leadTotal = 0 } = {}) {
  const operations = [];
  const leadRequests = [];
  let inFlight = 0;
  let peakConcurrency = 0;
  const publishedById = new Map();
  const settle = [];

  return {
    operations,
    leadRequests,
    get peakConcurrency() {
      return peakConcurrency;
    },
    /** Let every read that is currently waiting return. */
    releaseAll() {
      const pending = settle.splice(0, settle.length);
      for (const resolve of pending) resolve();
    },
    get pendingCount() {
      return settle.length;
    },
    dependencies: {
      delay: async () => {},
      relaySelf: async () => RELAY_PUBKEY,
      relaySupportsDiscovery: async () => true,
      credentialStatus: async () => "configured",
      subscribe: async () => async () => {},
      sign: async ({ kind, content, createdAt, tags }) =>
        finalizeEvent(
          { kind, content, created_at: createdAt ?? 1_785_665_600, tags },
          ACTOR_SECRET,
        ),
      publish: async (event) => {
        publishedById.set(event.id, event);
        return event;
      },
      fetchFirstEvent: async (filter) => {
        const actionEvent = publishedById.get(filter["#e"]?.[0] ?? "");
        assert.ok(
          actionEvent,
          "an action must be published before its receipt",
        );
        const action = JSON.parse(actionEvent.content);
        const request = action.request;
        const operation = actionEvent.tags.find(
          (tag) => tag[0] === "discovery-workspace-action",
        )[2];
        operations.push(operation);

        inFlight += 1;
        peakConcurrency = Math.max(peakConcurrency, inFlight);
        // Hold every read open for a turn so genuinely concurrent callers
        // overlap here rather than completing one at a time by accident.
        await new Promise((resolve) => {
          settle.push(resolve);
          queueMicrotask(() => {
            const index = settle.indexOf(resolve);
            if (index >= 0) {
              settle.splice(index, 1);
              resolve();
            }
          });
        });
        inFlight -= 1;

        let result;
        if (operation === "access") {
          result = { result: "access", active: true };
        } else if (operation === "list_lead_counts") {
          result = {
            result: "lead_counts",
            counts: {
              total: leadTotal,
              industries: [
                {
                  industryId: "automotive",
                  verticalId: null,
                  count: leadTotal,
                },
              ],
              verticals: [
                {
                  industryId: "automotive",
                  verticalId: "auto-repair",
                  count: leadTotal,
                },
              ],
            },
          };
        } else if (operation === "list_leads") {
          const { offset, limit } = request.payload.request;
          leadRequests.push({ offset, limit });
          const rows = [];
          for (
            let i = offset;
            i < Math.min(offset + limit, leadTotal);
            i += 1
          ) {
            rows.push(leadRow(i));
          }
          result = {
            result: "leads",
            page: { leads: rows, total: leadTotal, offset, limit },
          };
        } else {
          throw new Error(`unexpected operation ${operation}`);
        }

        return finalizeEvent(
          {
            kind: 40022,
            created_at: 1_785_665_601,
            tags: [
              ["p", actionEvent.pubkey],
              ["e", actionEvent.id, "", "discovery-workspace-action"],
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
          RELAY_SECRET,
        );
      },
    },
  };
}

test("concurrent industry and vertical reads share one lead-count round trip", async () => {
  const live = relay({ leadTotal: 1 });
  const source = new RelayDiscoveryDataSource(live.dependencies);

  const [industries, verticals] = await Promise.all([
    source.getIndustries(),
    source.getVerticals("automotive"),
  ]);

  assert.equal(
    live.operations.filter((op) => op === "list_lead_counts").length,
    1,
    "one screen load must not ask the relay for lead counts twice",
  );
  assert.equal(
    industries.find((item) => item.id === "automotive")?.leadCount,
    1,
    "the shared read still carries counts to industries",
  );
  assert.equal(
    verticals.find((item) => item.id === "auto-repair")?.leadCount,
    1,
    "the shared read still carries counts to verticals",
  );
});

test("a settled lead-count read is not reused by the next screen", async () => {
  const live = relay({ leadTotal: 1 });
  const source = new RelayDiscoveryDataSource(live.dependencies);

  await source.getLeadCounts();
  await source.getLeadCounts();

  assert.equal(
    live.operations.filter((op) => op === "list_lead_counts").length,
    2,
    "coalescing must only collapse reads that overlap, never serve a stale count",
  );
});

test("lead pages after the first are fetched concurrently", async () => {
  const live = relay({ leadTotal: 250 });
  const source = new RelayDiscoveryDataSource(live.dependencies);

  const page = await source.getLeads({
    scope: "global",
    page: 1,
    pageSize: 500,
  });

  assert.equal(page.total, 250, "every lead is returned");
  assert.equal(page.leads.length, 250);
  assert.deepEqual(
    live.leadRequests.map((request) => request.offset).sort((a, b) => a - b),
    [0, 100, 200],
    "three bounded pages cover 250 leads",
  );
  assert.equal(
    live.peakConcurrency,
    2,
    "the two pages after the first must be in flight together, not one after another",
  );
});

test("a single lead page issues no follow-up read", async () => {
  const live = relay({ leadTotal: 40 });
  const source = new RelayDiscoveryDataSource(live.dependencies);

  const page = await source.getLeads({
    scope: "global",
    page: 1,
    pageSize: 500,
  });

  assert.equal(page.leads.length, 40);
  assert.equal(
    live.leadRequests.length,
    1,
    "a workspace that fits in one page must cost exactly one lead read",
  );
});
