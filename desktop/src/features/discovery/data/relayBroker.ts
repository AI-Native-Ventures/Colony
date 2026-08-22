import { verifyEvent } from "nostr-tools/pure";

import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_DISCOVERY_ACTION,
  KIND_DISCOVERY_RECEIPT,
  KIND_DISCOVERY_WORKER_RECEIPT,
  KIND_DISCOVERY_WORKSPACE_ACTION,
  KIND_DISCOVERY_WORKSPACE_RECEIPT,
} from "@/shared/constants/kinds";

import type { LeadCounts, LeadDetail } from "../types";
import type {
  CampaignBudgetProjection,
  CampaignProjection,
  LeadProjection,
  RunProjection,
} from "./relayDiscoveryModels";
import { relaySupportsDiscovery } from "./relayDiscoverySupport";

const WORKSPACE_ACTION_SCHEMA = "colony.discovery-workspace-action/v3";
const WORKSPACE_RECEIPT_SCHEMA = "colony.discovery-workspace-receipt/v3";
const RUN_RECEIPT_SCHEMA_V2 = "colony.discovery-receipt/v2";
const RUN_ACTION_SCHEMA_V3 = "colony.discovery-action/v3";
const RUN_RECEIPT_SCHEMA_V3 = "colony.discovery-receipt/v3";
const WORKER_RECEIPT_SCHEMAS = new Set([
  "colony.discovery-worker-receipt/v1",
  "colony.discovery-worker-receipt/v2",
  "colony.discovery-worker-receipt/v3",
]);
const RECEIPT_ATTEMPTS = 20;
const RECEIPT_INTERVAL_MS = 300;
export const RUN_STATUS_INTERVAL_MS = 10_000;

export type WorkspaceResult =
  | { result: "access"; active: boolean }
  | { result: "campaign"; campaign: CampaignProjection }
  | { result: "budget"; budget: CampaignBudgetProjection }
  | {
      result: "campaigns";
      page: {
        campaigns: CampaignProjection[];
        total: number;
        offset: number;
        limit: number;
      };
    }
  | {
      result: "leads";
      page: {
        leads: LeadProjection[];
        total: number;
        offset: number;
        limit: number;
      };
    }
  | {
      result: "lead_counts";
      counts: LeadCounts;
    }
  | {
      result: "lead";
      lead: LeadDetail;
    };

export type WorkspaceOperation =
  | "access"
  | "create_campaign"
  | "update_campaign_sources"
  | "approve_campaign_budget"
  | "pause_campaign_budget"
  | "revoke_campaign_budget"
  | "get_campaign_budget"
  | "get_campaign"
  | "list_campaigns"
  | "list_leads"
  | "list_lead_counts"
  | "get_lead"
  | "update_lead";
export type RunOperation = "start" | "status" | "cancel";

export type DiscoveryBrokerDependencies = {
  identityPubkey?: () => Promise<string>;
  delay: (ms: number) => Promise<void>;
  fetchFirstEvent: (
    filter: RelaySubscriptionFilter,
  ) => Promise<RelayEvent | null>;
  publish: (event: RelayEvent) => Promise<RelayEvent>;
  relaySelf: () => Promise<string | null>;
  relaySupportsDiscovery: () => Promise<boolean>;
  sign: typeof signRelayEvent;
  subscribe: (
    filter: RelaySubscriptionFilter,
    onEvent: (event: RelayEvent) => void,
  ) => Promise<() => Promise<void>>;
};

export const DEFAULT_BROKER: DiscoveryBrokerDependencies = {
  delay: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
  fetchFirstEvent: (filter) => relayClient.fetchFirstEvent(filter),
  publish: (event) =>
    relayClient.publishEvent(
      event,
      "Timed out while sending the Discovery request.",
      "The Discovery request could not be sent.",
    ),
  relaySelf: getRelaySelf,
  relaySupportsDiscovery,
  sign: signRelayEvent,
  subscribe: (filter, onEvent) => relayClient.subscribeLive(filter, onEvent),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Match buzz_core::block::canonical_json byte for byte. */
export function canonicalDiscoveryJson(value: unknown): string {
  return canonicalDiscoveryJsonAt(value, "$");
}

function canonicalDiscoveryJsonAt(value: unknown, path: string): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Discovery records cannot contain non-finite numbers at ${path}.`,
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => canonicalDiscoveryJsonAt(item, `${path}[${index}]`))
      .join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalDiscoveryJsonAt(
            value[key],
            `${path}.${key}`,
          )}`,
      )
      .join(",")}}`;
  }
  throw new Error(
    `Discovery records must contain JSON values only at ${path} (got ${String(value)}).`,
  );
}

function exactTags(event: RelayEvent, names: string[]): boolean {
  if (event.tags.length !== names.length) return false;
  const actual = event.tags.map((tag) => tag[0]).sort();
  return actual.join("|") === [...names].sort().join("|");
}

function oneTag(event: RelayEvent, name: string): string[] | null {
  const tags = event.tags.filter((tag) => tag[0] === name);
  return tags.length === 1 ? (tags[0] as string[]) : null;
}

function trustedEvent(
  event: RelayEvent,
  kind: number,
  relayPubkey: string,
): boolean {
  if (
    event.kind !== kind ||
    event.pubkey.toLowerCase() !== relayPubkey.toLowerCase()
  ) {
    return false;
  }
  try {
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    });
  } catch {
    return false;
  }
}

function parseCanonicalContent(
  event: RelayEvent,
): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(event.content);
    return isPlainObject(value) &&
      canonicalDiscoveryJson(value) === event.content
      ? value
      : null;
  } catch {
    return null;
  }
}

function parseWorkspaceReceipt(
  event: RelayEvent,
  relayPubkey: string,
  actorPubkey: string,
  actionEventId: string,
  operation: WorkspaceOperation,
  requestId: string,
  idempotencyKey: string,
): WorkspaceResult | null {
  if (
    !trustedEvent(event, KIND_DISCOVERY_WORKSPACE_RECEIPT, relayPubkey) ||
    !exactTags(event, ["p", "e", "discovery-workspace-receipt"])
  ) {
    return null;
  }
  const p = oneTag(event, "p");
  const e = oneTag(event, "e");
  const tuple = oneTag(event, "discovery-workspace-receipt");
  if (
    p?.length !== 2 ||
    p[1]?.toLowerCase() !== actorPubkey.toLowerCase() ||
    e?.length !== 4 ||
    e[1]?.toLowerCase() !== actionEventId.toLowerCase() ||
    e[2] !== "" ||
    e[3] !== "discovery-workspace-action" ||
    tuple?.length !== 5 ||
    tuple[1] !== "3" ||
    tuple[2] !== operation ||
    tuple[3] !== requestId ||
    tuple[4] !== idempotencyKey
  ) {
    return null;
  }
  const content = parseCanonicalContent(event);
  const receipt = content?.receipt;
  if (
    content?.schema !== WORKSPACE_RECEIPT_SCHEMA ||
    !isPlainObject(receipt) ||
    receipt.operation !== operation ||
    receipt.request_id !== requestId ||
    receipt.idempotency_key !== idempotencyKey ||
    !isPlainObject(receipt.result)
  ) {
    return null;
  }
  return receipt.result as WorkspaceResult;
}

function parseRunReceipt(
  event: RelayEvent,
  relayPubkey: string,
  actorPubkey: string,
  actionEventId: string,
  operation: RunOperation,
  requestId: string,
  idempotencyKey: string,
): RunProjection | null {
  const wireVersion = operation === "start" ? "3" : "2";
  const receiptSchema =
    operation === "start" ? RUN_RECEIPT_SCHEMA_V3 : RUN_RECEIPT_SCHEMA_V2;
  if (
    !trustedEvent(event, KIND_DISCOVERY_RECEIPT, relayPubkey) ||
    !exactTags(event, ["p", "e", "run", "discovery-receipt"])
  ) {
    return null;
  }
  const p = oneTag(event, "p");
  const e = oneTag(event, "e");
  const run = oneTag(event, "run");
  const tuple = oneTag(event, "discovery-receipt");
  if (
    p?.[1]?.toLowerCase() !== actorPubkey.toLowerCase() ||
    e?.length !== 4 ||
    e[1]?.toLowerCase() !== actionEventId.toLowerCase() ||
    e[2] !== "" ||
    e[3] !== "discovery-action" ||
    run?.length !== 2 ||
    tuple?.length !== 6 ||
    tuple[1] !== wireVersion ||
    tuple[2] !== operation ||
    tuple[3] !== requestId ||
    tuple[4] !== idempotencyKey ||
    tuple[5] !== run[1]
  ) {
    return null;
  }
  const content = parseCanonicalContent(event);
  if (
    content?.schema !== receiptSchema ||
    content.operation !== operation ||
    content.request_id !== requestId ||
    content.idempotency_key !== idempotencyKey ||
    !isPlainObject(content.run) ||
    content.run.run_id !== run[1]
  ) {
    return null;
  }
  return content.run as RunProjection;
}

function workerRunId(
  event: RelayEvent,
  relayPubkey: string,
  actorPubkey: string,
): string | null {
  if (
    !trustedEvent(event, KIND_DISCOVERY_WORKER_RECEIPT, relayPubkey) ||
    oneTag(event, "p")?.[1]?.toLowerCase() !== actorPubkey.toLowerCase()
  ) {
    return null;
  }
  const content = parseCanonicalContent(event);
  const tuple = oneTag(event, "discovery-worker-receipt");
  if (
    tuple?.length !== 6 ||
    (tuple[1] !== "1" && tuple[1] !== "2" && tuple[1] !== "3") ||
    content?.schema !== `colony.discovery-worker-receipt/v${tuple[1]}` ||
    !WORKER_RECEIPT_SCHEMAS.has(content.schema) ||
    !isPlainObject(content.outcome)
  ) {
    return null;
  }
  const outcome = content.outcome;
  const value = outcome.value;
  if (!isPlainObject(value)) return null;
  if (outcome.status === "lease" && isPlainObject(value.run)) {
    return typeof value.run.run_id === "string" ? value.run.run_id : null;
  }
  if (
    outcome.status === "observations_stored" &&
    isPlainObject(value.lease) &&
    isPlainObject(value.lease.run)
  ) {
    return typeof value.lease.run.run_id === "string"
      ? value.lease.run.run_id
      : null;
  }
  return typeof value.run_id === "string" ? value.run_id : null;
}

export class DiscoveryBroker {
  private readonly dependencies: DiscoveryBrokerDependencies;

  constructor(dependencies: DiscoveryBrokerDependencies) {
    this.dependencies = dependencies;
  }

  async workspace(
    operation: WorkspaceOperation,
    payload: Record<string, unknown>,
  ): Promise<WorkspaceResult> {
    const relayPubkey = await this.requireRelayIdentity();
    const requestId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    const request = {
      request_id: requestId,
      idempotency_key: idempotencyKey,
      payload,
    };
    const action = await this.dependencies.sign({
      kind: KIND_DISCOVERY_WORKSPACE_ACTION,
      content: canonicalDiscoveryJson({
        schema: WORKSPACE_ACTION_SCHEMA,
        request,
      }),
      tags: [
        ["p", relayPubkey],
        [
          "discovery-workspace-action",
          "3",
          operation,
          requestId,
          idempotencyKey,
        ],
      ],
    });
    await this.dependencies.publish(action);
    for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt += 1) {
      const event = await this.dependencies.fetchFirstEvent({
        kinds: [KIND_DISCOVERY_WORKSPACE_RECEIPT],
        authors: [relayPubkey],
        "#e": [action.id],
        "#p": [action.pubkey],
        limit: 1,
      });
      const result = event
        ? parseWorkspaceReceipt(
            event,
            relayPubkey,
            action.pubkey,
            action.id,
            operation,
            requestId,
            idempotencyKey,
          )
        : null;
      if (result) return result;
      if (attempt < RECEIPT_ATTEMPTS - 1) {
        await this.dependencies.delay(RECEIPT_INTERVAL_MS);
      }
    }
    throw new Error(
      "The relay accepted the Discovery request but has not returned its signed result yet.",
    );
  }

  async run(
    operation: RunOperation,
    input: {
      campaignId?: string;
      runId?: string;
    },
    beforePublish?: (actorPubkey: string, relayPubkey: string) => Promise<void>,
  ): Promise<{ actorPubkey: string; relayPubkey: string; run: RunProjection }> {
    const relayPubkey = await this.requireRelayIdentity();
    const requestId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    const target = operation === "start" ? input.campaignId : input.runId;
    if (!target) throw new Error("Discovery request target is missing.");
    const wireVersion = "3";
    const content = {
      schema: RUN_ACTION_SCHEMA_V3,
      operation,
      request_id: requestId,
      idempotency_key: idempotencyKey,
      campaign_id: operation === "start" ? target : null,
      run_id: operation === "start" ? null : target,
      ...(operation === "start" ? { protocol_version: 3 } : {}),
    };
    const action = await this.dependencies.sign({
      kind: KIND_DISCOVERY_ACTION,
      content: canonicalDiscoveryJson(content),
      tags: [
        ["p", relayPubkey],
        [operation === "start" ? "campaign" : "run", target],
        ["discovery-action", wireVersion, operation, requestId, idempotencyKey],
      ],
    });
    await beforePublish?.(action.pubkey, relayPubkey);
    await this.dependencies.publish(action);
    for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt += 1) {
      const event = await this.dependencies.fetchFirstEvent({
        kinds: [KIND_DISCOVERY_RECEIPT],
        authors: [relayPubkey],
        "#e": [action.id],
        "#p": [action.pubkey],
        limit: 1,
      });
      const run = event
        ? parseRunReceipt(
            event,
            relayPubkey,
            action.pubkey,
            action.id,
            operation,
            requestId,
            idempotencyKey,
          )
        : null;
      if (run) return { actorPubkey: action.pubkey, relayPubkey, run };
      if (attempt < RECEIPT_ATTEMPTS - 1) {
        await this.dependencies.delay(RECEIPT_INTERVAL_MS);
      }
    }
    throw new Error(
      "The relay accepted the Discovery run request but has not returned its signed result yet.",
    );
  }

  async subscribeToWorker(
    actorPubkey: string,
    relayPubkey: string,
    onRun: (runId: string) => void,
  ): Promise<() => Promise<void>> {
    return this.dependencies.subscribe(
      {
        kinds: [KIND_DISCOVERY_WORKER_RECEIPT],
        authors: [relayPubkey],
        "#p": [actorPubkey],
        since: Math.floor(Date.now() / 1_000) - 5,
        limit: 100,
      },
      (event) => {
        const runId = workerRunId(event, relayPubkey, actorPubkey);
        if (runId) onRun(runId);
      },
    );
  }
  async requireRelayIdentity(): Promise<string> {
    const relayPubkey = await this.dependencies.relaySelf();
    if (!relayPubkey) {
      throw new Error(
        "This workspace relay has no stable identity, so Discovery cannot verify its records.",
      );
    }
    return relayPubkey;
  }
}
