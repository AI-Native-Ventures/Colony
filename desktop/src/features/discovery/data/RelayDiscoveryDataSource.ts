import { verifyEvent } from "nostr-tools/pure";

import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import { getDiscoveryOutscraperCredentialStatus } from "@/shared/api/discoveryCredentials";
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

import type { DiscoveryEntitlement } from "../entitlement";
import type { CampaignSourceConfig } from "../sourceConfig";
import type {
  CampaignDetail,
  CampaignDraft,
  ConversationThread,
  DiscoveryEvent,
  Industry,
  LeadPage,
  LeadScope,
  OutreachDraft,
  OutreachStatus,
  ProfessionalField,
  ProfessionalRole,
  ProfessionalRoleDetail,
  Vertical,
  VerticalDetail,
} from "../types";
import type { DiscoveryDataSource } from "./DiscoveryDataSource";
import { createFixtureDiscoveryDataSource } from "./FixtureDiscoveryDataSource";
import {
  type CampaignProjection,
  eventBase,
  isTerminal,
  type LeadProjection,
  mapCampaign,
  mapLead,
  mapRun,
  type RunProjection,
  sourceMetric,
} from "./relayDiscoveryModels";

const WORKSPACE_ACTION_SCHEMA = "colony.discovery-workspace-action/v1";
const WORKSPACE_RECEIPT_SCHEMA = "colony.discovery-workspace-receipt/v1";
const RUN_ACTION_SCHEMA = "colony.discovery-action/v1";
const RUN_RECEIPT_SCHEMA = "colony.discovery-receipt/v1";
const WORKER_RECEIPT_SCHEMA = "colony.discovery-worker-receipt/v1";
const RECEIPT_ATTEMPTS = 20;
const RECEIPT_INTERVAL_MS = 300;
const RUN_STATUS_INTERVAL_MS = 10_000;

type WorkspaceResult =
  | { result: "access"; active: boolean }
  | { result: "campaign"; campaign: CampaignProjection }
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
    };

type WorkspaceOperation =
  | "access"
  | "create_campaign"
  | "get_campaign"
  | "list_campaigns"
  | "list_leads";
type RunOperation = "start" | "status" | "cancel";

export type DiscoveryBrokerDependencies = {
  credentialStatus?: typeof getDiscoveryOutscraperCredentialStatus;
  delay: (ms: number) => Promise<void>;
  fetchFirstEvent: (
    filter: RelaySubscriptionFilter,
  ) => Promise<RelayEvent | null>;
  publish: (event: RelayEvent) => Promise<RelayEvent>;
  relaySelf: () => Promise<string | null>;
  sign: typeof signRelayEvent;
  subscribe: (
    filter: RelaySubscriptionFilter,
    onEvent: (event: RelayEvent) => void,
  ) => Promise<() => Promise<void>>;
};

const DEFAULT_BROKER: DiscoveryBrokerDependencies = {
  credentialStatus: getDiscoveryOutscraperCredentialStatus,
  delay: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
  fetchFirstEvent: (filter) => relayClient.fetchFirstEvent(filter),
  publish: (event) =>
    relayClient.publishEvent(
      event,
      "Timed out while sending the Discovery request.",
      "The Discovery request could not be sent.",
    ),
  relaySelf: getRelaySelf,
  sign: signRelayEvent,
  subscribe: (filter, onEvent) => relayClient.subscribeLive(filter, onEvent),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Match buzz_core::block::canonical_json byte for byte. */
export function canonicalDiscoveryJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Discovery records cannot contain non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalDiscoveryJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalDiscoveryJson(value[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("Discovery records must contain JSON values only.");
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
    tuple[1] !== "1" ||
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
    tuple[1] !== "1" ||
    tuple[2] !== operation ||
    tuple[3] !== requestId ||
    tuple[4] !== idempotencyKey ||
    tuple[5] !== run[1]
  ) {
    return null;
  }
  const content = parseCanonicalContent(event);
  if (
    content?.schema !== RUN_RECEIPT_SCHEMA ||
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
  if (
    content?.schema !== WORKER_RECEIPT_SCHEMA ||
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

class DiscoveryBroker {
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
          "1",
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
      businessSearch?: Record<string, unknown>;
    },
    beforePublish?: (actorPubkey: string, relayPubkey: string) => Promise<void>,
  ): Promise<{ actorPubkey: string; relayPubkey: string; run: RunProjection }> {
    const relayPubkey = await this.requireRelayIdentity();
    const requestId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    const target = operation === "start" ? input.campaignId : input.runId;
    if (!target) throw new Error("Discovery request target is missing.");
    const content = {
      schema: RUN_ACTION_SCHEMA,
      operation,
      request_id: requestId,
      idempotency_key: idempotencyKey,
      campaign_id: operation === "start" ? target : null,
      run_id: operation === "start" ? null : target,
      business_search: operation === "start" ? input.businessSearch : null,
    };
    const action = await this.dependencies.sign({
      kind: KIND_DISCOVERY_ACTION,
      content: canonicalDiscoveryJson(content),
      tags: [
        ["p", relayPubkey],
        [operation === "start" ? "campaign" : "run", target],
        ["discovery-action", "1", operation, requestId, idempotencyKey],
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

class RunSignal {
  private pending = 0;
  private waiters: Array<() => void> = [];

  push() {
    const waiter = this.waiters.shift();
    if (waiter) waiter();
    else this.pending += 1;
  }

  async wait(timeoutMs: number): Promise<void> {
    if (this.pending > 0) {
      this.pending -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        const index = this.waiters.indexOf(finish);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve();
      };
      const timeout = window.setTimeout(finish, timeoutMs);
      this.waiters.push(finish);
    });
  }
}

export class RelayDiscoveryDataSource implements DiscoveryDataSource {
  private readonly broker: DiscoveryBroker;
  private readonly demo = createFixtureDiscoveryDataSource({
    entitlement: "not_entitled",
  });
  private entitlementPromise: Promise<DiscoveryEntitlement> | null = null;
  private readonly activeRuns = new Map<string, string>();
  private readonly credentialStatus: typeof getDiscoveryOutscraperCredentialStatus;

  constructor(dependencies: DiscoveryBrokerDependencies = DEFAULT_BROKER) {
    this.broker = new DiscoveryBroker(dependencies);
    this.credentialStatus =
      dependencies.credentialStatus ?? getDiscoveryOutscraperCredentialStatus;
  }

  getEntitlement(): Promise<DiscoveryEntitlement> {
    if (!this.entitlementPromise) {
      this.entitlementPromise = this.broker
        .workspace("access", { operation: "access" })
        .then((result) => {
          if (result.result !== "access") {
            throw new Error(
              "The relay returned the wrong Discovery access result.",
            );
          }
          return {
            feature: "discovery_engine" as const,
            state: result.active
              ? ("entitled" as const)
              : ("not_entitled" as const),
            planName: "LAKA",
            experience: result.active ? ("live" as const) : ("demo" as const),
          };
        })
        .catch((error) => {
          this.entitlementPromise = null;
          throw error;
        });
    }
    return this.entitlementPromise;
  }

  private async live(): Promise<boolean> {
    return (await this.getEntitlement()).experience === "live";
  }

  getIndustries(): Promise<Industry[]> {
    return this.demo.getIndustries();
  }

  getVerticals(industryId: string): Promise<Vertical[]> {
    return this.demo.getVerticals(industryId);
  }

  async getVertical(
    industryId: string,
    verticalId: string,
  ): Promise<VerticalDetail> {
    const base = await this.demo.getVertical(industryId, verticalId);
    if (!(await this.live())) return base;
    const campaigns = await this.listCampaigns(industryId, verticalId);
    return { ...base, campaigns };
  }

  getFields(): Promise<ProfessionalField[]> {
    return this.demo.getFields();
  }

  getRoles(fieldId: string): Promise<ProfessionalRole[]> {
    return this.demo.getRoles(fieldId);
  }

  getRole(fieldId: string, roleId: string): Promise<ProfessionalRoleDetail> {
    return this.demo.getRole(fieldId, roleId);
  }

  async getCampaign(campaignId: string): Promise<CampaignDetail> {
    if (!(await this.live())) return this.demo.getCampaign(campaignId);
    const result = await this.broker.workspace("get_campaign", {
      operation: "get_campaign",
      campaign_id: campaignId,
    });
    if (result.result !== "campaign") {
      throw new Error("The relay returned the wrong campaign result.");
    }
    return mapCampaign(result.campaign);
  }

  async getLeads(scope: LeadScope): Promise<LeadPage> {
    if (!(await this.live())) return this.demo.getLeads(scope);
    if (scope.targetType === "individual") {
      return {
        leads: [],
        total: 0,
        page: 1,
        pageSize: scope.pageSize ?? 25,
        hasNextPage: false,
      };
    }
    const all = await this.listLeadProjections(scope);
    let leads = all.map(mapLead);
    if (scope.status)
      leads = leads.filter((lead) => lead.status === scope.status);
    if (scope.search) {
      const query = scope.search.trim().toLowerCase();
      leads = leads.filter((lead) =>
        [lead.companyName, lead.location, lead.website, lead.phone]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(query)),
      );
    }
    const page = Math.max(1, scope.page ?? 1);
    const pageSize = Math.max(1, scope.pageSize ?? 25);
    const start = (page - 1) * pageSize;
    return {
      leads: leads.slice(start, start + pageSize),
      total: leads.length,
      page,
      pageSize,
      hasNextPage: start + pageSize < leads.length,
    };
  }

  async getOutreach(campaignId: string): Promise<OutreachDraft[]> {
    if (!(await this.live())) return this.demo.getOutreach(campaignId);
    await this.getCampaign(campaignId);
    return [];
  }

  async createOutreach(campaignId: string): Promise<OutreachDraft> {
    if (!(await this.live())) return this.demo.createOutreach(campaignId);
    throw new Error(
      "Multichannel Outreach is outside the first live Discovery phase.",
    );
  }

  async updateOutreachStatus(
    campaignId: string,
    outreachId: string,
    status: OutreachStatus,
  ): Promise<OutreachDraft> {
    if (!(await this.live())) {
      return this.demo.updateOutreachStatus(campaignId, outreachId, status);
    }
    throw new Error(
      "Multichannel Outreach is outside the first live Discovery phase.",
    );
  }

  async getConversations(campaignId: string): Promise<ConversationThread[]> {
    if (!(await this.live())) return this.demo.getConversations(campaignId);
    await this.getCampaign(campaignId);
    return [];
  }

  async markConversationRead(
    campaignId: string,
    conversationId: string,
  ): Promise<ConversationThread> {
    if (!(await this.live())) {
      return this.demo.markConversationRead(campaignId, conversationId);
    }
    throw new Error(
      "Conversations are outside the first live Discovery phase.",
    );
  }

  async sendConversationReply(
    campaignId: string,
    conversationId: string,
    body: string,
  ): Promise<ConversationThread> {
    if (!(await this.live())) {
      return this.demo.sendConversationReply(campaignId, conversationId, body);
    }
    throw new Error(
      "Conversations are outside the first live Discovery phase.",
    );
  }

  async createCampaign(input: CampaignDraft): Promise<CampaignDetail> {
    if (!(await this.live())) {
      throw new Error(
        "Activate LAKA before creating a live Discovery campaign.",
      );
    }
    if ((input.targetType ?? "business") !== "business") {
      throw new Error(
        "People discovery is not included in the first live phase.",
      );
    }
    const target = Math.round(input.target);
    if (!Number.isFinite(target) || target < 1 || target > 500) {
      throw new Error("Choose a lead target from 1 to 500.");
    }
    const [industry, vertical] = await Promise.all([
      this.demo
        .getIndustries()
        .then((items) => items.find((item) => item.id === input.industryId)),
      this.demo.getVertical(input.industryId, input.verticalId),
    ]);
    if (!industry) throw new Error("This Discovery industry is unavailable.");
    const result = await this.broker.workspace("create_campaign", {
      operation: "create_campaign",
      campaign: {
        campaign_id: crypto.randomUUID(),
        name: input.name.trim() || `${vertical.name} campaign`,
        industry_id: industry.id,
        industry_name: industry.name,
        vertical_id: vertical.id,
        vertical_name: vertical.name,
        query: vertical.name,
        location: input.location.trim(),
        target,
        description: input.description?.trim() || null,
        language: "en",
        region: null,
      },
    });
    if (result.result !== "campaign") {
      throw new Error("The relay returned the wrong campaign result.");
    }
    return mapCampaign(result.campaign);
  }

  async updateSourceConfig(
    campaignId: string,
    config: CampaignSourceConfig,
  ): Promise<CampaignDetail> {
    if (!(await this.live()))
      return this.demo.updateSourceConfig(campaignId, config);
    if (
      config.mode !== "waterfall" ||
      config.order.join("|") !== "google_maps"
    ) {
      throw new Error(
        "The first live phase uses Outscraper / Google Maps only.",
      );
    }
    return this.getCampaign(campaignId);
  }

  startDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent> {
    return this.runDiscovery(campaignId);
  }

  async cancelDiscovery(campaignId: string): Promise<void> {
    if (!(await this.live())) return this.demo.cancelDiscovery(campaignId);
    const campaign = await this.getCampaign(campaignId);
    const runId = this.activeRuns.get(campaignId) ?? campaign.run?.id;
    if (!runId || campaign.run?.status !== "running") return;
    await this.broker.run("cancel", { runId });
  }

  retryDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent> {
    return this.runDiscovery(campaignId);
  }

  private async *runDiscovery(
    campaignId: string,
  ): AsyncIterable<DiscoveryEvent> {
    if (!(await this.live())) {
      throw new Error("Activate LAKA before running live Discovery.");
    }
    const credential = await this.credentialStatus();
    if (credential !== "configured") {
      throw new Error(
        credential === "missing"
          ? "Connect your Outscraper API key in Settings > Discovery before starting."
          : "Colony cannot access the secure credential store on this device.",
      );
    }
    const current = await this.getCampaign(campaignId);
    const signal = new RunSignal();
    let runId = "";
    const workerSubscription: { stop?: () => Promise<void> } = {};
    const started = await this.broker.run(
      "start",
      {
        campaignId,
        businessSearch: {
          query: current.verticalName,
          location: current.location,
          limit: current.target,
          language: "en",
          region: null,
        },
      },
      async (actorPubkey, relayPubkey) => {
        workerSubscription.stop = await this.broker.subscribeToWorker(
          actorPubkey,
          relayPubkey,
          (candidate) => {
            if (!runId || candidate === runId) signal.push();
          },
        );
      },
    );
    runId = started.run.run_id;
    this.activeRuns.set(campaignId, runId);
    try {
      let campaign = await this.getCampaignProjection(campaignId);
      let lastFingerprint = "";
      yield { type: "session_started", ...eventBase(campaign) };
      yield {
        type: "source_started",
        source: "google_maps",
        metric: sourceMetric(campaign),
        sourceMetric: sourceMetric(campaign),
        ...eventBase(campaign),
      };
      while (campaign.latest_run && !isTerminal(campaign.latest_run)) {
        await signal.wait(RUN_STATUS_INTERVAL_MS);
        campaign = await this.getCampaignProjection(campaignId);
        const fingerprint = `${campaign.latest_run?.state}:${campaign.latest_run?.completed_steps}:${campaign.lead_count}`;
        if (fingerprint === lastFingerprint) continue;
        lastFingerprint = fingerprint;
        const metric = sourceMetric(campaign);
        yield {
          type: "source_progress",
          source: "google_maps",
          metric,
          sourceMetric: metric,
          progress: mapRun(campaign).completion,
          message: `${campaign.lead_count} unique Leads retained`,
          ...eventBase(campaign),
        };
      }
      const base = eventBase(campaign);
      if (campaign.latest_run?.state === "succeeded") {
        const metric = sourceMetric(campaign);
        yield {
          type: "source_completed",
          source: "google_maps",
          metric,
          sourceMetric: metric,
          ...base,
        };
        if (campaign.lead_count >= campaign.target) {
          yield { type: "target_reached", targetReached: true, ...base };
        }
        yield {
          type: "session_completed",
          targetReached: campaign.lead_count >= campaign.target,
          partial: campaign.lead_count < campaign.target,
          ...base,
        };
      } else if (campaign.latest_run?.state === "cancelled") {
        yield { type: "session_cancelled", ...base };
      } else {
        yield {
          type: "session_failed",
          error: mapRun(campaign).error ?? "Discovery failed.",
          ...base,
        };
      }
    } finally {
      this.activeRuns.delete(campaignId);
      await workerSubscription.stop?.();
    }
  }

  private async getCampaignProjection(
    campaignId: string,
  ): Promise<CampaignProjection> {
    const result = await this.broker.workspace("get_campaign", {
      operation: "get_campaign",
      campaign_id: campaignId,
    });
    if (result.result !== "campaign") throw new Error("Campaign read failed.");
    return result.campaign;
  }

  private async listCampaigns(
    industryId: string,
    verticalId: string,
  ): Promise<CampaignDetail[]> {
    const campaigns: CampaignProjection[] = [];
    let offset = 0;
    for (;;) {
      const result = await this.broker.workspace("list_campaigns", {
        operation: "list_campaigns",
        request: {
          industry_id: industryId,
          vertical_id: verticalId,
          offset,
          limit: 100,
        },
      });
      if (result.result !== "campaigns")
        throw new Error("Campaign list failed.");
      campaigns.push(...result.page.campaigns);
      offset += result.page.campaigns.length;
      if (offset >= result.page.total || result.page.campaigns.length === 0)
        break;
    }
    return campaigns.map(mapCampaign);
  }

  private async listLeadProjections(
    scope: LeadScope,
  ): Promise<LeadProjection[]> {
    const leads: LeadProjection[] = [];
    let offset = 0;
    for (;;) {
      const result = await this.broker.workspace("list_leads", {
        operation: "list_leads",
        request: {
          campaign_id:
            (scope.scope ?? scope.kind ?? scope.type) === "campaign"
              ? (scope.campaignId ?? null)
              : null,
          industry_id: scope.industryId ?? null,
          vertical_id: scope.verticalId ?? null,
          offset,
          limit: 100,
        },
      });
      if (result.result !== "leads") throw new Error("Lead list failed.");
      leads.push(...result.page.leads);
      offset += result.page.leads.length;
      if (offset >= result.page.total || result.page.leads.length === 0) break;
    }
    return leads;
  }
}

export function createRelayDiscoveryDataSource(): DiscoveryDataSource {
  return new RelayDiscoveryDataSource();
}
