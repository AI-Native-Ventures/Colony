import type {
  DiscoveryEntitlement,
  DiscoveryEntitlementState,
} from "../entitlement";
import {
  resolveSourceConfig,
  type CampaignSourceConfig,
} from "../sourceConfig";
import type {
  CampaignDetail,
  CampaignDraft,
  CampaignStatus,
  DiscoveryEvent,
  Industry,
  Lead,
  LeadPage,
  LeadScope,
  CampaignSummary,
  Vertical,
  VerticalDetail,
} from "../types";
import type { DiscoveryDataSource } from "./DiscoveryDataSource";
import {
  CAMPAIGN_FIXTURE,
  FIXTURE_CAMPAIGN_LEADS,
  FIXTURE_GLOBAL_LEADS,
  FIXTURE_INDUSTRIES,
  FIXTURE_VERTICAL_DETAILS,
  createIdleDiscoveryRun,
} from "./fixtures";
import {
  createFixtureEventSequence,
  type FixtureScenario,
} from "./fixtureEvents";

export type FixtureDiscoveryDataSourceOptions = {
  entitlement?: DiscoveryEntitlementState | DiscoveryEntitlement;
  scenario?: FixtureScenario;
};

export type CreateFixtureDiscoveryDataSourceOptions =
  FixtureDiscoveryDataSourceOptions;

const TERMINAL_EVENT_TYPES = new Set<DiscoveryEvent["type"]>([
  "session_completed",
  "session_cancelled",
  "session_failed",
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function campaignStatusForEvent(event: DiscoveryEvent): CampaignStatus {
  if (event.type === "session_completed") {
    return event.partial ? "partial" : "completed";
  }
  if (event.type === "session_cancelled") return "cancelled";
  if (event.type === "session_failed") return "failed";
  return "running";
}

function isTerminalEvent(event: DiscoveryEvent): boolean {
  return TERMINAL_EVENT_TYPES.has(event.type);
}

type ActiveDiscoveryRun = {
  token: string;
  runId: string;
  cancelled: boolean;
};

export function createFixtureDiscoveryDataSource(
  options: CreateFixtureDiscoveryDataSourceOptions = {},
): DiscoveryDataSource {
  return new FixtureDiscoveryDataSource(options);
}

export class FixtureDiscoveryDataSource implements DiscoveryDataSource {
  private readonly entitlement: DiscoveryEntitlement;
  private readonly defaultScenario: FixtureScenario;
  private readonly campaigns = new Map<string, CampaignDetail>();
  private readonly campaignLeads = new Map<string, Lead[]>();
  private readonly campaignRunCounts = new Map<string, number>();
  private readonly activeRuns = new Map<string, ActiveDiscoveryRun>();
  private readonly campaignScenarios = new Map<string, FixtureScenario>();
  private nextCampaignNumber = 1;
  private nextRunToken = 1;

  constructor(options: FixtureDiscoveryDataSourceOptions = {}) {
    this.entitlement = normalizeEntitlement(options.entitlement);
    this.defaultScenario = options.scenario ?? "concurrent";

    const fixtureCampaign = clone(CAMPAIGN_FIXTURE);
    fixtureCampaign.run = createIdleDiscoveryRun(fixtureCampaign);
    this.campaigns.set(fixtureCampaign.id, fixtureCampaign);
    this.campaignLeads.set(fixtureCampaign.id, clone(FIXTURE_CAMPAIGN_LEADS));
    this.campaignRunCounts.set(fixtureCampaign.id, 0);
    this.campaignScenarios.set(fixtureCampaign.id, this.defaultScenario);
  }

  async getEntitlement(): Promise<DiscoveryEntitlement> {
    return clone(this.entitlement);
  }

  async getIndustries(): Promise<Industry[]> {
    return clone(FIXTURE_INDUSTRIES);
  }

  async getVerticals(industryId: string): Promise<Vertical[]> {
    return clone(
      FIXTURE_VERTICAL_DETAILS.filter(
        (item) => item.industryId === industryId,
      ).map(({ campaigns: _campaigns, ...vertical }) => vertical),
    );
  }

  async getVertical(
    industryId: string,
    verticalId: string,
  ): Promise<VerticalDetail> {
    const vertical = FIXTURE_VERTICAL_DETAILS.find(
      (item) => item.industryId === industryId && item.id === verticalId,
    );
    if (!vertical) {
      throw new Error(
        `Unknown discovery vertical: ${industryId}/${verticalId}`,
      );
    }
    const campaigns = [...this.campaigns.values()]
      .filter(
        (campaign) =>
          campaign.industryId === industryId &&
          campaign.verticalId === verticalId,
      )
      .map((campaign) => toCampaignSummary(campaign));
    return clone({ ...vertical, campaigns });
  }

  async getCampaign(campaignId: string): Promise<CampaignDetail> {
    return clone(this.requireCampaign(campaignId));
  }

  async getLeads(scope: LeadScope): Promise<LeadPage> {
    const scopeKind = scope.scope ?? scope.kind ?? scope.type ?? "global";
    const sourceLeads =
      scopeKind === "campaign"
        ? clone(this.campaignLeads.get(scope.campaignId ?? "") ?? [])
        : this.getGlobalLeads();
    let leads = sourceLeads.filter((lead) => {
      if (scopeKind === "campaign" && scope.campaignId) {
        return lead.campaignIds.includes(scope.campaignId);
      }
      return true;
    });
    if (scope.industryId)
      leads = leads.filter((lead) => lead.industryId === scope.industryId);
    if (scope.verticalId)
      leads = leads.filter((lead) => lead.verticalId === scope.verticalId);
    if (scope.status)
      leads = leads.filter((lead) => lead.status === scope.status);
    if (scope.search) {
      const query = scope.search.toLowerCase();
      leads = leads.filter((lead) =>
        [lead.companyName, lead.location, lead.contactName, lead.email]
          .filter(Boolean)
          .some((field) => field?.toLowerCase().includes(query)),
      );
    }

    const page = Math.max(1, scope.page ?? 1);
    const pageSize = Math.max(1, scope.pageSize ?? 25);
    const start = (page - 1) * pageSize;
    return {
      leads: clone(leads.slice(start, start + pageSize)),
      total: leads.length,
      page,
      pageSize,
      hasNextPage: start + pageSize < leads.length,
    };
  }

  async createCampaign(input: CampaignDraft): Promise<CampaignDetail> {
    const industry = FIXTURE_INDUSTRIES.find(
      (item) => item.id === input.industryId,
    );
    const vertical = FIXTURE_VERTICAL_DETAILS.find(
      (item) =>
        item.industryId === input.industryId && item.id === input.verticalId,
    );
    if (!industry || !vertical) {
      throw new Error(
        `Unknown discovery vertical: ${input.industryId}/${input.verticalId}`,
      );
    }
    if (!Number.isFinite(input.target) || input.target <= 0) {
      throw new Error(
        "Discovery campaign target must be a finite positive number",
      );
    }
    const target = Math.round(input.target);
    if (target <= 0) {
      throw new Error(
        "Discovery campaign target must round to at least one lead",
      );
    }
    const baseId =
      slugify(input.name) || `discovery-campaign-${this.nextCampaignNumber}`;
    let id = baseId;
    while (this.campaigns.has(id)) {
      this.nextCampaignNumber += 1;
      id = `${baseId}-${this.nextCampaignNumber}`;
    }
    const createdAt = "2026-08-01T10:00:00.000Z";
    const campaign: CampaignDetail = {
      id,
      name: input.name.trim() || "Untitled Discovery Campaign",
      industryId: industry.id,
      verticalId: vertical.id,
      industryName: industry.name,
      verticalName: vertical.name,
      location: input.location.trim(),
      description: input.description,
      status: "ready",
      target,
      targetLeads: target,
      leadCount: 0,
      createdAt,
      updatedAt: createdAt,
      sourceConfig: resolveSourceConfig(input.sourceConfig),
      metrics: {
        companiesFound: 0,
        contactsFound: 0,
        emailsFound: 0,
        missingWebsites: 0,
      },
    };
    campaign.run = createIdleDiscoveryRun(campaign);
    this.campaigns.set(id, campaign);
    this.campaignLeads.set(id, []);
    this.campaignRunCounts.set(id, 0);
    this.campaignScenarios.set(id, this.defaultScenario);
    return clone(campaign);
  }

  async updateSourceConfig(
    campaignId: string,
    config: CampaignSourceConfig,
  ): Promise<CampaignDetail> {
    const campaign = this.requireCampaign(campaignId);
    this.activeRuns.delete(campaignId);
    campaign.sourceConfig = resolveSourceConfig(config);
    campaign.run = createIdleDiscoveryRun(campaign);
    campaign.updatedAt = "2026-08-01T10:05:00.000Z";
    campaign.status = "ready";
    return clone(campaign);
  }

  startDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent> {
    const campaign = this.requireCampaign(campaignId);
    this.activeRuns.delete(campaignId);
    campaign.run = createIdleDiscoveryRun(campaign);
    campaign.status = "ready";
    campaign.updatedAt = "2026-08-01T10:20:00.000Z";
    const scenario =
      this.campaignScenarios.get(campaignId) ?? this.defaultScenario;
    return this.createStream(campaignId, scenario);
  }

  async cancelDiscovery(campaignId: string): Promise<void> {
    const campaign = this.requireCampaign(campaignId);
    const activeRun = this.activeRuns.get(campaignId);
    if (
      !activeRun ||
      campaign.status === "completed" ||
      campaign.status === "partial" ||
      campaign.status === "cancelled" ||
      campaign.status === "failed"
    ) {
      return;
    }
    activeRun.cancelled = true;
    const run = campaign.run ?? createIdleDiscoveryRun(campaign);
    run.id = activeRun.runId;
    run.status = "cancelled";
    run.phase = "completed";
    run.completedAt = "2026-08-01T10:30:00.000Z";
    campaign.run = run;
    campaign.status = "cancelled";
    campaign.updatedAt = run.completedAt;
  }

  retryDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent> {
    const campaign = this.requireCampaign(campaignId);
    const previous =
      this.campaignScenarios.get(campaignId) ?? this.defaultScenario;
    const scenario: FixtureScenario =
      previous === "failed" || previous === "cancelled"
        ? "concurrent"
        : previous;
    this.campaignScenarios.set(campaignId, scenario);
    campaign.run = createIdleDiscoveryRun(campaign);
    campaign.status = "ready";
    return this.createStream(campaignId, scenario);
  }

  private createStream(
    campaignId: string,
    scenario: FixtureScenario,
  ): AsyncIterable<DiscoveryEvent> {
    const campaign = this.requireCampaign(campaignId);
    const leads =
      campaignId === CAMPAIGN_FIXTURE.id
        ? FIXTURE_CAMPAIGN_LEADS
        : FIXTURE_GLOBAL_LEADS;
    const existingLeadIds =
      (this.campaignRunCounts.get(campaignId) ?? 0) > 0
        ? new Set(
            (this.campaignLeads.get(campaignId) ?? []).map((lead) => lead.id),
          )
        : new Set<string>();
    const events = createFixtureEventSequence(
      campaign,
      leads,
      scenario,
      existingLeadIds,
    );
    const runId = events[0]?.runId ?? `${campaignId}-run-${scenario}`;
    const token = `${campaignId}:${this.nextRunToken}`;
    this.nextRunToken += 1;
    this.activeRuns.set(campaignId, {
      token,
      runId,
      cancelled: false,
    });
    return this.streamEvents(campaignId, events, token);
  }

  private async *streamEvents(
    campaignId: string,
    events: DiscoveryEvent[],
    token: string,
  ): AsyncIterable<DiscoveryEvent> {
    for (const event of events) {
      await Promise.resolve();
      const activeRun = this.activeRuns.get(campaignId);
      if (!activeRun || activeRun.token !== token) return;
      if (activeRun.cancelled) {
        const cancelled = this.createCancellationEvent(campaignId, event);
        this.applyEvent(cancelled);
        this.campaignRunCounts.set(
          campaignId,
          (this.campaignRunCounts.get(campaignId) ?? 0) + 1,
        );
        this.activeRuns.delete(campaignId);
        yield cancelled;
        return;
      }
      this.applyEvent(event);
      yield clone(event);
      if (isTerminalEvent(event)) {
        this.campaignRunCounts.set(
          campaignId,
          (this.campaignRunCounts.get(campaignId) ?? 0) + 1,
        );
        this.activeRuns.delete(campaignId);
        return;
      }
    }
  }

  private createCancellationEvent(
    campaignId: string,
    previousEvent: DiscoveryEvent,
  ): DiscoveryEvent {
    this.requireCampaign(campaignId);
    const run = clone(previousEvent.run);
    run.status = "cancelled";
    run.phase = "completed";
    run.completedAt = "2026-08-01T10:30:00.000Z";
    return {
      type: "session_cancelled",
      campaignId,
      runId: run.id,
      at: "2026-08-01T10:30:00.000Z",
      run: clone(run),
    };
  }

  private applyEvent(event: DiscoveryEvent): void {
    const campaign = this.requireCampaign(event.campaignId);
    campaign.run = clone(event.run);
    campaign.status = campaignStatusForEvent(event);
    campaign.updatedAt = event.at;
    if (event.type === "lead_stored") {
      const leads = this.campaignLeads.get(event.campaignId) ?? [];
      if (!leads.some((lead) => lead.id === event.lead.id)) {
        const lead: Lead = {
          ...clone(event.lead),
          campaignIds: [
            ...new Set([...event.lead.campaignIds, event.campaignId]),
          ],
        };
        leads.push(lead);
        this.campaignLeads.set(event.campaignId, leads);
      }
    }
    const leads = this.campaignLeads.get(event.campaignId) ?? [];
    campaign.leadCount = leads.length;
    campaign.metrics = {
      companiesFound: leads.length,
      contactsFound: leads.reduce((total, lead) => total + lead.contacts, 0),
      emailsFound: leads.filter((lead) => Boolean(lead.email)).length,
      missingWebsites: leads.filter((lead) => !lead.website).length,
    };
    if (isTerminalEvent(event))
      campaign.updatedAt = event.run.completedAt ?? event.at;
  }

  private requireCampaign(campaignId: string): CampaignDetail {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) throw new Error(`Unknown discovery campaign: ${campaignId}`);
    return campaign;
  }

  private getGlobalLeads(): Lead[] {
    const leads = new Map(
      FIXTURE_GLOBAL_LEADS.map((lead) => [lead.id, clone(lead)]),
    );
    for (const campaignLeads of this.campaignLeads.values()) {
      for (const lead of campaignLeads) leads.set(lead.id, clone(lead));
    }
    return [...leads.values()];
  }
}

function normalizeEntitlement(
  value: FixtureDiscoveryDataSourceOptions["entitlement"],
): DiscoveryEntitlement {
  if (typeof value === "object" && value !== null) return clone(value);
  switch (value) {
    case "not_entitled":
      return {
        feature: "discovery_engine",
        state: "not_entitled",
        planName: "LAKA",
      };
    case "loading":
      return { feature: "discovery_engine", state: "loading" };
    case "error":
      return { feature: "discovery_engine", state: "error" };
    default:
      return {
        feature: "discovery_engine",
        state: "entitled",
        planName: "LAKA",
      };
  }
}

function toCampaignSummary(campaign: CampaignDetail): CampaignSummary {
  const {
    sourceConfig: _sourceConfig,
    run: _run,
    metrics: _metrics,
    ...summary
  } = campaign;
  return summary;
}
