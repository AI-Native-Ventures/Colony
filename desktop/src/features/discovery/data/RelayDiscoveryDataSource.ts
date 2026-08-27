import { getIdentity } from "@/shared/api/tauriIdentity";

import type { DiscoveryEntitlement } from "../entitlement";
import type { DiscoverySource } from "../sourceConfig";
import type {
  CampaignDetail,
  CampaignDraft,
  ConversationThread,
  DiscoveryEvent,
  Industry,
  LeadDetail,
  LeadFunnelStatus,
  LeadCounts,
  LeadPage,
  PipelineColumn,
  LeadScope,
  LeadUpdateInput,
  OutreachDraft,
  OutreachStatus,
  ProfessionalField,
  ProfessionalRole,
  ProfessionalRoleDetail,
  Vertical,
  VerticalDetail,
} from "../types";
import { PIPELINE_COLUMN_STATUSES } from "../types";
import type { DiscoveryDataSource } from "./DiscoveryDataSource";
import { createFixtureDiscoveryDataSource } from "./FixtureDiscoveryDataSource";
import { sourceEvents, sourceFingerprint } from "./relayDiscoveryEvents";
import {
  approvedCampaignBudgetNanousd,
  campaignBudgetFingerprint,
  DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD,
} from "./campaignBudget";
import {
  DEMO_DISCOVERY_ENTITLEMENT,
  relaySupportsDiscovery,
} from "./relayDiscoverySupport";
import {
  type CampaignProjection,
  eventBase,
  isTerminal,
  type LeadProjection,
  mapCampaign,
  mapLead,
  mapRun,
} from "./relayDiscoveryModels";
import {
  DEFAULT_BROKER,
  DiscoveryBroker,
  type DiscoveryBrokerDependencies,
  type DiscoveryEntitySummary as EntitySummary,
  RUN_STATUS_INTERVAL_MS,
} from "./relayBroker";

export { canonicalDiscoveryJson } from "./relayBroker";

/** The relay's per-request lead page size, shared by every paginated read. */
const LEAD_PAGE_LIMIT = 100;

type RawLeadDetail = LeadProjection & {
  status?: string;
  owner_persona_id?: string | null;
  website_override?: string | null;
  email?: string | null;
  phone_override?: string | null;
  linkedin_url?: string | null;
  contact_name?: string | null;
  contact_title?: string | null;
  notes?: string | null;
  score?: number | null;
  updated_by?: string | null;
  updated_at?: string | null;
};

function mapLeadDetail(raw: RawLeadDetail): LeadDetail {
  const lead = mapLead(raw);
  return {
    ...lead,
    website: raw.website_override ?? lead.website,
    phone: raw.phone_override ?? lead.phone,
    email: raw.email ?? lead.email,
    linkedinUrl: raw.linkedin_url ?? lead.linkedinUrl,
    contactName: raw.contact_name ?? lead.contactName,
    contactTitle: raw.contact_title ?? lead.contactTitle,
    score: raw.score ?? lead.score,
    status: (raw.status ?? "candidate") as LeadFunnelStatus,
    owner: raw.owner_persona_id ?? undefined,
    notes: raw.notes ?? undefined,
    updatedAt: raw.updated_at ?? undefined,
  };
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
  /**
   * The in-flight `list_lead_counts` read, shared by every concurrent caller.
   *
   * One screen load asks for counts twice, once through `getIndustries` and
   * again through `getVerticals`, and both reads answer the same question. The
   * promise is held only while the request is in flight and is cleared as soon
   * as it settles, so this coalesces the duplicate round trip without ever
   * serving a cached count. Freshness is unchanged; only the second identical
   * request in the same tick disappears.
   */
  private leadCountsPromise: Promise<LeadCounts> | null = null;
  private readonly activeRuns = new Map<string, string>();
  private readonly identityPubkey: () => Promise<string>;
  private readonly relaySupportsDiscovery: () => Promise<boolean>;
  constructor(dependencies: DiscoveryBrokerDependencies = DEFAULT_BROKER) {
    this.broker = new DiscoveryBroker(dependencies);
    this.identityPubkey =
      dependencies.identityPubkey ??
      (async () => {
        const identity = await getIdentity();
        return identity.pubkey;
      });
    this.relaySupportsDiscovery =
      dependencies.relaySupportsDiscovery ?? relaySupportsDiscovery;
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
            experience: result.active ? ("live" as const) : ("demo" as const),
          };
        })
        .catch(async (error) => {
          const advertisesDiscovery = await this.relaySupportsDiscovery().catch(
            () => null,
          );
          if (advertisesDiscovery === false) {
            return DEMO_DISCOVERY_ENTITLEMENT;
          }
          this.entitlementPromise = null;
          throw error;
        });
    }
    return this.entitlementPromise;
  }
  private async live(): Promise<boolean> {
    return (await this.getEntitlement()).experience === "live";
  }
  getLeadCounts(): Promise<LeadCounts> {
    if (this.leadCountsPromise) return this.leadCountsPromise;
    const pending = this.readLeadCounts().finally(() => {
      if (this.leadCountsPromise === pending) this.leadCountsPromise = null;
    });
    this.leadCountsPromise = pending;
    return pending;
  }

  /**
   * Search the mentionable Discovery entities of this community: canonical
   * taxonomy rows, Campaigns, Leads, Lead collections, and runs. Bounded by
   * the relay at 20 rows; free per the approved Discovery pricing decisions.
   */
  async searchEntities(query: string, limit = 10): Promise<EntitySummary[]> {
    if (!(await this.live())) return [];
    const result = await this.broker.workspace("search_entities", {
      operation: "search_entities",
      query,
      limit,
    });
    if (result.result !== "entity_search") {
      throw new Error("The relay returned the wrong entity-search result.");
    }
    return result.entities;
  }

  private async readLeadCounts(): Promise<LeadCounts> {
    if (!(await this.live())) return this.demo.getLeadCounts();
    const result = await this.broker.workspace("list_lead_counts", {
      operation: "list_lead_counts",
    });
    if (result.result !== "lead_counts") {
      throw new Error("The relay returned the wrong lead-count result.");
    }
    return {
      ...result.counts,
      industries: result.counts.industries.map((row) => ({
        ...row,
        verticalId: row.verticalId ?? undefined,
      })),
      verticals: result.counts.verticals.map((row) => ({
        ...row,
        verticalId: row.verticalId ?? undefined,
      })),
    };
  }

  async getLead(leadId: string): Promise<LeadDetail> {
    if (!(await this.live())) return this.demo.getLead(leadId);
    const result = await this.broker.workspace("get_lead", {
      operation: "get_lead",
      lead_id: leadId,
    });
    if (result.result !== "lead") {
      throw new Error("The relay returned the wrong lead result.");
    }
    return mapLeadDetail(result.lead as unknown as RawLeadDetail);
  }

  async updateLead(
    leadId: string,
    input: LeadUpdateInput,
  ): Promise<LeadDetail> {
    if (!(await this.live())) return this.demo.updateLead(leadId, input);
    const result = await this.broker.workspace("update_lead", {
      operation: "update_lead",
      lead_id: leadId,
      input: {
        website: input.website ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        linkedin_url: input.linkedinUrl ?? null,
        contact_name: input.contactName ?? null,
        contact_title: input.contactTitle ?? null,
        notes: input.notes ?? null,
        score: input.score ?? null,
        owner_persona_id: input.owner ?? null,
        status: input.status ?? null,
      },
    });
    if (result.result !== "lead") {
      throw new Error("The relay returned the wrong lead result.");
    }
    return mapLeadDetail(result.lead as unknown as RawLeadDetail);
  }

  async getIndustries(): Promise<Industry[]> {
    const base = await this.demo.getIndustries();
    if (!(await this.live())) return base;
    const counts = await this.getLeadCounts();
    const byIndustry = new Map(
      counts.industries.map((row) => [row.industryId, row.count]),
    );
    return base.map((industry) => ({
      ...industry,
      leadCount: byIndustry.get(industry.id) ?? 0,
    }));
  }

  async getVerticals(industryId: string): Promise<Vertical[]> {
    const base = await this.demo.getVerticals(industryId);
    if (!(await this.live())) return base;
    const counts = await this.getLeadCounts();
    const byVertical = new Map(
      counts.verticals
        .filter((row) => row.verticalId)
        .map((row) => [`${row.industryId}/${row.verticalId}`, row.count]),
    );
    return base.map((vertical) => ({
      ...vertical,
      leadCount: byVertical.get(`${vertical.industryId}/${vertical.id}`) ?? 0,
    }));
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

  /**
   * The Pipeline's column data: one bounded, status-filtered `list_leads`
   * call per column, returning the relay's `total`.
   *
   * This deliberately does not use `getLeads` or `listLeadProjections`:
   * those loop to exhaustion and slice client-side, which is right for the
   * searchable workspace but would pull every lead for six columns. Each
   * column here is capped at one page and reports the relay total, so a
   * large funnel stays cheap to render.
   */
  async getPipelineColumns(): Promise<PipelineColumn[]> {
    if (!(await this.live())) return this.demo.getPipelineColumns();
    return Promise.all(
      PIPELINE_COLUMN_STATUSES.map(async (status) => {
        const result = await this.broker.workspace("list_leads", {
          operation: "list_leads",
          request: {
            campaign_id: null,
            industry_id: null,
            vertical_id: null,
            status,
            offset: 0,
            limit: 100,
          },
        });
        if (result.result !== "leads") throw new Error("Lead list failed.");
        return {
          status,
          total: result.page.total,
          leads: result.page.leads.map(mapLead),
        };
      }),
    );
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
        "Discovery access is required to create a live campaign.",
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
    const campaignId = crypto.randomUUID();
    const campaignInput = {
      campaign_id: campaignId,
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
    };
    const budgetApproval = await this.campaignBudgetApproval(campaignInput);
    const result = await this.broker.workspace("create_campaign", {
      operation: "create_campaign",
      campaign: campaignInput,
      budget_approval: budgetApproval,
    });
    if (result.result !== "campaign") {
      throw new Error("The relay returned the wrong campaign result.");
    }
    return mapCampaign(result.campaign);
  }

  async approveCampaignBudget(campaignId: string): Promise<CampaignDetail> {
    if (!(await this.live())) {
      throw new Error("Campaign budgets apply to live Discovery only.");
    }
    const campaign = await this.getCampaignProjection(campaignId);
    const approval = await this.broker.workspace("approve_campaign_budget", {
      operation: "approve_campaign_budget",
      approval: await this.campaignBudgetApproval(campaign),
    });
    if (approval.result !== "budget") {
      throw new Error("The relay did not confirm the Campaign budget.");
    }
    return mapCampaign({ ...campaign, budget: approval.budget });
  }

  async pauseCampaignBudget(campaignId: string): Promise<CampaignDetail> {
    return this.changeCampaignBudget("pause_campaign_budget", campaignId);
  }

  async revokeCampaignBudget(campaignId: string): Promise<CampaignDetail> {
    return this.changeCampaignBudget("revoke_campaign_budget", campaignId);
  }

  private async campaignBudgetApproval(
    campaign: Pick<
      CampaignProjection,
      | "campaign_id"
      | "industry_id"
      | "vertical_id"
      | "query"
      | "location"
      | "target"
      | "language"
      | "region"
    >,
  ) {
    const payerPubkey = await this.identityPubkey();
    const approvedNanousd = approvedCampaignBudgetNanousd(campaign.target);
    const fingerprint = await campaignBudgetFingerprint({
      campaignId: campaign.campaign_id,
      industryId: campaign.industry_id,
      verticalId: campaign.vertical_id,
      query: campaign.query,
      location: campaign.location,
      target: campaign.target,
      language: campaign.language,
      region: campaign.region,
      payerPubkey,
    });
    return {
      campaign_id: campaign.campaign_id,
      payer_pubkey: payerPubkey,
      approved_nanousd: approvedNanousd,
      price_per_retained_lead_nanousd:
        DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD.toString(),
      campaign_fingerprint: fingerprint,
      approval_action_event_id: null,
      approval_expires_at: null,
    };
  }

  private async changeCampaignBudget(
    operation: "pause_campaign_budget" | "revoke_campaign_budget",
    campaignId: string,
  ): Promise<CampaignDetail> {
    if (!(await this.live())) {
      throw new Error("Campaign budgets apply to live Discovery only.");
    }
    const result = await this.broker.workspace(operation, {
      operation,
      campaign_id: campaignId,
    });
    if (result.result !== "budget") {
      throw new Error("The relay did not confirm the Campaign budget change.");
    }
    const campaign = await this.getCampaignProjection(campaignId);
    return mapCampaign({ ...campaign, budget: result.budget });
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
      throw new Error("Discovery access is required to run live Discovery.");
    }
    const current = await this.getCampaign(campaignId);
    if (current.budget?.state !== "active") {
      throw new Error(
        current.budget?.state === "exhausted"
          ? "This Campaign has used its approved Colony Credits budget."
          : "Approve a Colony Credits budget before starting Discovery.",
      );
    }
    const signal = new RunSignal();
    let runId = "";
    const workerSubscription: { stop?: () => Promise<void> } = {};
    const started = await this.broker.run(
      "start",
      {
        campaignId,
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
      const previousSources = new Map<DiscoverySource, string>();
      let lastFingerprint = "";
      yield { type: "session_started", ...eventBase(campaign) };
      for (const event of sourceEvents(previousSources, campaign)) yield event;
      while (campaign.latest_run && !isTerminal(campaign.latest_run)) {
        await signal.wait(RUN_STATUS_INTERVAL_MS);
        campaign = await this.getCampaignProjection(campaignId);
        const fingerprint = `${campaign.latest_run?.state}:${campaign.latest_run?.completed_steps}:${campaign.lead_count}:${(
          campaign.latest_run_sources ?? []
        )
          .map(sourceFingerprint)
          .join("|")}`;
        if (fingerprint === lastFingerprint) continue;
        lastFingerprint = fingerprint;
        for (const event of sourceEvents(previousSources, campaign))
          yield event;
      }
      const base = eventBase(campaign);
      if (campaign.latest_run?.state === "succeeded") {
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

  /**
   * Every lead matching `scope`, read one bounded page at a time.
   *
   * The first page reports the relay's `total`, so the remaining pages are
   * known up front and are fetched concurrently rather than one after another.
   * A serial loop cost one full round trip per hundred leads, which is what
   * made the Leads workspace take seconds to open.
   *
   * `total` can move between the first page and the rest. A short read is
   * accepted rather than retried: this is a list view, and the next open reads
   * it again.
   */
  private async listLeadProjections(
    scope: LeadScope,
  ): Promise<LeadProjection[]> {
    const first = await this.listLeadPage(scope, 0);
    if (first.leads.length === 0 || first.leads.length >= first.total) {
      return first.leads;
    }
    const offsets: number[] = [];
    for (
      let offset = first.leads.length;
      offset < first.total;
      offset += LEAD_PAGE_LIMIT
    ) {
      offsets.push(offset);
    }
    const rest = await Promise.all(
      offsets.map((offset) => this.listLeadPage(scope, offset)),
    );
    return [...first.leads, ...rest.flatMap((page) => page.leads)];
  }

  private async listLeadPage(
    scope: LeadScope,
    offset: number,
  ): Promise<{ leads: LeadProjection[]; total: number }> {
    const result = await this.broker.workspace("list_leads", {
      operation: "list_leads",
      request: {
        campaign_id:
          (scope.scope ?? scope.kind ?? scope.type) === "campaign"
            ? (scope.campaignId ?? null)
            : null,
        industry_id: scope.industryId ?? null,
        vertical_id: scope.verticalId ?? null,
        status: scope.status ?? null,
        offset,
        limit: LEAD_PAGE_LIMIT,
      },
    });
    if (result.result !== "leads") throw new Error("Lead list failed.");
    return { leads: result.page.leads, total: result.page.total };
  }
}

export function createRelayDiscoveryDataSource(): DiscoveryDataSource {
  return new RelayDiscoveryDataSource();
}
