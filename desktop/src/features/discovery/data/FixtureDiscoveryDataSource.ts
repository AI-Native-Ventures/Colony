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
  LeadPage,
  LeadScope,
  CampaignSummary,
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

export function createFixtureDiscoveryDataSource(
  options: CreateFixtureDiscoveryDataSourceOptions = {},
): DiscoveryDataSource {
  return new FixtureDiscoveryDataSource(options);
}

export class FixtureDiscoveryDataSource implements DiscoveryDataSource {
  private readonly entitlement: DiscoveryEntitlement;
  private readonly defaultScenario: FixtureScenario;
  private readonly campaigns = new Map<string, CampaignDetail>();
  private readonly cancelledCampaigns = new Set<string>();
  private readonly campaignScenarios = new Map<string, FixtureScenario>();
  private nextCampaignNumber = 1;

  constructor(options: FixtureDiscoveryDataSourceOptions = {}) {
    this.entitlement = normalizeEntitlement(options.entitlement);
    this.defaultScenario = options.scenario ?? "concurrent";

    const fixtureCampaign = clone(CAMPAIGN_FIXTURE);
    fixtureCampaign.run = createIdleDiscoveryRun(fixtureCampaign);
    this.campaigns.set(fixtureCampaign.id, fixtureCampaign);
    this.campaignScenarios.set(fixtureCampaign.id, this.defaultScenario);
  }

  async getEntitlement(): Promise<DiscoveryEntitlement> {
    return clone(this.entitlement);
  }

  async getIndustries(): Promise<Industry[]> {
    return clone(FIXTURE_INDUSTRIES);
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
      scopeKind === "campaign" ? FIXTURE_CAMPAIGN_LEADS : FIXTURE_GLOBAL_LEADS;
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
      target: Math.max(1, Math.round(input.target)),
      targetLeads: Math.max(1, Math.round(input.target)),
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
    this.campaignScenarios.set(id, this.defaultScenario);
    return clone(campaign);
  }

  async updateSourceConfig(
    campaignId: string,
    config: CampaignSourceConfig,
  ): Promise<CampaignDetail> {
    const campaign = this.requireCampaign(campaignId);
    campaign.sourceConfig = resolveSourceConfig(config);
    campaign.run = createIdleDiscoveryRun(campaign);
    campaign.updatedAt = "2026-08-01T10:05:00.000Z";
    campaign.status = "ready";
    return clone(campaign);
  }

  startDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent> {
    this.requireCampaign(campaignId);
    this.cancelledCampaigns.delete(campaignId);
    const scenario =
      this.campaignScenarios.get(campaignId) ?? this.defaultScenario;
    return this.createStream(campaignId, scenario);
  }

  async cancelDiscovery(campaignId: string): Promise<void> {
    const campaign = this.requireCampaign(campaignId);
    this.cancelledCampaigns.add(campaignId);
    const run = campaign.run ?? createIdleDiscoveryRun(campaign);
    run.status = "cancelled";
    run.phase = "completed";
    run.completedAt = "2026-08-01T10:30:00.000Z";
    campaign.run = run;
    campaign.status = "cancelled";
    campaign.updatedAt = run.completedAt;
  }

  retryDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent> {
    const campaign = this.requireCampaign(campaignId);
    this.cancelledCampaigns.delete(campaignId);
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
    const events = createFixtureEventSequence(campaign, leads, scenario);
    return this.streamEvents(campaignId, events);
  }

  private async *streamEvents(
    campaignId: string,
    events: DiscoveryEvent[],
  ): AsyncIterable<DiscoveryEvent> {
    let emittedTerminal = false;
    let eventIndex = 0;
    for (const event of events) {
      await Promise.resolve();
      if (
        eventIndex > 0 &&
        this.cancelledCampaigns.has(campaignId) &&
        !emittedTerminal
      ) {
        const cancelled = this.createCancellationEvent(campaignId, event);
        this.applyEvent(cancelled);
        emittedTerminal = true;
        eventIndex += 1;
        yield cancelled;
        return;
      }
      this.applyEvent(event);
      emittedTerminal = isTerminalEvent(event);
      eventIndex += 1;
      yield clone(event);
      if (emittedTerminal) return;
    }
  }

  private createCancellationEvent(
    campaignId: string,
    previousEvent: DiscoveryEvent,
  ): DiscoveryEvent {
    const campaign = this.requireCampaign(campaignId);
    const run = campaign.run ?? clone(previousEvent.run);
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
    campaign.leadCount = event.run.stored;
    campaign.metrics.companiesFound = event.run.stored;
    if (isTerminalEvent(event))
      campaign.updatedAt = event.run.completedAt ?? event.at;
  }

  private requireCampaign(campaignId: string): CampaignDetail {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) throw new Error(`Unknown discovery campaign: ${campaignId}`);
    return campaign;
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
