import type {
  DiscoveryEntitlement,
  DiscoveryEntitlementState,
} from "../entitlement";
import { canMoveLead, relationshipLabel } from "../lib/pipelineTransitions";
import {
  resolveSourceConfig,
  type CampaignSourceConfig,
} from "../sourceConfig";
import type {
  CampaignDetail,
  CampaignDraft,
  CampaignSummary,
  CampaignStatus,
  ConversationThread,
  DiscoveryEvent,
  Industry,
  Lead,
  LeadDetail,
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
import {
  CAMPAIGN_FIXTURE,
  FIXTURE_CAMPAIGN_LEADS,
  FIXTURE_FIELDS,
  FIXTURE_GLOBAL_LEADS,
  FIXTURE_INDUSTRIES,
  FIXTURE_PEOPLE_CAMPAIGN,
  FIXTURE_PEOPLE_LEADS,
  FIXTURE_PRO_SERVICES_CAMPAIGN,
  FIXTURE_PRO_SERVICES_LEADS,
  FIXTURE_ROLE_DETAILS,
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
  /** Return an empty global Leads page so the empty state is browser-testable. */
  emptyLeads?: boolean;
  /**
   * Make `updateLead` reject with this message, simulating a relay refusal
   * so the drawer's inline rejection path is browser-testable in demo mode.
   */
  updateLeadReject?: string;
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

function seedOutreach(
  campaign: CampaignDetail,
  leads: readonly Lead[],
): OutreachDraft[] {
  return leads.slice(0, 5).map((lead, index) => {
    const channel =
      index % 3 === 0 ? "Email" : index % 3 === 1 ? "LinkedIn" : "WhatsApp";
    const person =
      lead.personName ?? lead.contactName ?? `Team at ${lead.companyName}`;
    const company = lead.currentCompany ?? lead.companyName;
    return {
      id: `${campaign.id}-${lead.id}`,
      campaignId: campaign.id,
      leadId: lead.id,
      lead: person,
      company,
      channel,
      subject: `A quick idea for ${company}`,
      body: `Hi ${person.split(" ")[0]}, I noticed ${company} while researching ${campaign.verticalName.toLowerCase()} teams in ${campaign.location}. I have a specific idea that could help—would a short conversation this week be useful?`,
      status: index === 0 ? "Approved" : index === 1 ? "Scheduled" : "Draft",
    };
  });
}

function seedConversations(
  campaign: CampaignDetail,
  leads: readonly Lead[],
): ConversationThread[] {
  return leads.slice(0, 4).map((lead, index) => ({
    id: `${campaign.id}-conversation-${lead.id}`,
    campaignId: campaign.id,
    leadId: lead.id,
    name: lead.personName ?? lead.contactName ?? lead.companyName,
    company: lead.currentCompany ?? lead.companyName,
    channel: index % 2 === 0 ? "Email" : "WhatsApp",
    unread: index < 2,
    messages: [
      {
        id: `${campaign.id}-${lead.id}-message-1`,
        direction: "inbound",
        body:
          index === 0
            ? "Hi — thanks for reaching out. The idea sounds relevant."
            : "Thanks for the note.",
        sentAt: "2026-08-01T09:20:00.000Z",
      },
      {
        id: `${campaign.id}-${lead.id}-message-2`,
        direction: "inbound",
        body:
          index === 0
            ? "Can you send over two examples before we book time?"
            : "What would the first week look like?",
        sentAt: "2026-08-01T09:25:00.000Z",
      },
    ],
  }));
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

const LEGACY_INDUSTRY_ALIASES: Readonly<Record<string, string>> = {
  finance: "financial-services",
  mining: "mining-resources",
  tourism: "hospitality",
};

const LEGACY_VERTICAL_ALIASES: Readonly<Record<string, string>> = {
  "professional-services/accounting-practices": "accounting-financial-advisory",
};

function canonicalIndustryId(industryId: string): string {
  return LEGACY_INDUSTRY_ALIASES[industryId] ?? industryId;
}

function canonicalVerticalId(industryId: string, verticalId: string): string {
  return LEGACY_VERTICAL_ALIASES[`${industryId}/${verticalId}`] ?? verticalId;
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
  private readonly campaignLeads = new Map<string, Lead[]>();
  private readonly campaignRunCounts = new Map<string, number>();
  private readonly activeRuns = new Map<string, ActiveDiscoveryRun>();
  private readonly campaignScenarios = new Map<string, FixtureScenario>();
  private readonly campaignOutreach = new Map<string, OutreachDraft[]>();
  private readonly campaignConversations = new Map<
    string,
    ConversationThread[]
  >();
  private readonly leadProfiles = new Map<string, Partial<LeadDetail>>();
  private readonly emptyLeads: boolean;
  private readonly updateLeadReject?: string;
  private nextCampaignNumber = 1;
  private nextRunToken = 1;

  constructor(options: FixtureDiscoveryDataSourceOptions = {}) {
    this.entitlement = normalizeEntitlement(options.entitlement);
    this.defaultScenario = options.scenario ?? "concurrent";
    this.emptyLeads = options.emptyLeads ?? false;
    this.updateLeadReject = options.updateLeadReject;

    const fixtureCampaign = clone(CAMPAIGN_FIXTURE);
    fixtureCampaign.run = createIdleDiscoveryRun(fixtureCampaign);
    this.campaigns.set(fixtureCampaign.id, fixtureCampaign);
    this.campaignLeads.set(fixtureCampaign.id, clone(FIXTURE_CAMPAIGN_LEADS));
    this.campaignRunCounts.set(fixtureCampaign.id, 0);
    this.campaignScenarios.set(fixtureCampaign.id, this.defaultScenario);
    this.campaignOutreach.set(
      fixtureCampaign.id,
      seedOutreach(fixtureCampaign, FIXTURE_CAMPAIGN_LEADS),
    );
    this.campaignConversations.set(
      fixtureCampaign.id,
      seedConversations(fixtureCampaign, FIXTURE_CAMPAIGN_LEADS),
    );

    const peopleCampaign = clone(FIXTURE_PEOPLE_CAMPAIGN);
    peopleCampaign.run = createIdleDiscoveryRun(peopleCampaign);
    this.campaigns.set(peopleCampaign.id, peopleCampaign);
    this.campaignLeads.set(peopleCampaign.id, clone(FIXTURE_PEOPLE_LEADS));
    this.campaignRunCounts.set(peopleCampaign.id, 0);
    this.campaignScenarios.set(peopleCampaign.id, this.defaultScenario);
    this.campaignOutreach.set(
      peopleCampaign.id,
      seedOutreach(peopleCampaign, FIXTURE_PEOPLE_LEADS),
    );
    this.campaignConversations.set(
      peopleCampaign.id,
      seedConversations(peopleCampaign, FIXTURE_PEOPLE_LEADS),
    );

    const servicesCampaign = clone(FIXTURE_PRO_SERVICES_CAMPAIGN);
    servicesCampaign.run = createIdleDiscoveryRun(servicesCampaign);
    this.campaigns.set(servicesCampaign.id, servicesCampaign);
    this.campaignLeads.set(
      servicesCampaign.id,
      clone(FIXTURE_PRO_SERVICES_LEADS),
    );
    this.campaignRunCounts.set(servicesCampaign.id, 0);
    this.campaignScenarios.set(servicesCampaign.id, this.defaultScenario);
    this.campaignOutreach.set(
      servicesCampaign.id,
      seedOutreach(servicesCampaign, FIXTURE_PRO_SERVICES_LEADS),
    );
    this.campaignConversations.set(
      servicesCampaign.id,
      seedConversations(servicesCampaign, FIXTURE_PRO_SERVICES_LEADS),
    );
  }

  async getEntitlement(): Promise<DiscoveryEntitlement> {
    return clone(this.entitlement);
  }

  async getIndustries(): Promise<Industry[]> {
    return clone(FIXTURE_INDUSTRIES);
  }

  async getLeadCounts(): Promise<LeadCounts> {
    const industries = FIXTURE_INDUSTRIES.map((industry) => ({
      industryId: industry.id,
      count: industry.leadCount,
    }));
    const verticals = FIXTURE_VERTICAL_DETAILS.map((vertical) => ({
      industryId: vertical.industryId,
      verticalId: vertical.id,
      count: vertical.leadCount,
    }));
    return {
      total: industries.reduce((sum, row) => sum + row.count, 0),
      industries,
      verticals,
    };
  }

  async getLead(leadId: string): Promise<LeadDetail> {
    const all = this.getGlobalLeads();
    const lead = all.find((candidate) => candidate.id === leadId);
    if (!lead) {
      throw new Error(`Unknown Discovery lead: ${leadId}`);
    }
    const profile = this.leadProfiles.get(leadId) ?? {};
    // The lead's own status is the fallback, not `candidate`. Hardcoding the
    // entry state here made the detail disagree with the list for any fixture
    // lead that starts further along: the drawer showed Candidate while the
    // row showed Qualified, and `updateLead`'s transition guard, which reads
    // the lead's status, then refused a move the drawer had just offered. The
    // relay defaults an absent profile row to Candidate because it has nothing
    // else to go on; here there is something else to go on.
    return {
      ...lead,
      status: profile.status ?? lead.status ?? "candidate",
      ...profile,
    } as LeadDetail;
  }

  async updateLead(
    leadId: string,
    input: LeadUpdateInput,
  ): Promise<LeadDetail> {
    if (this.updateLeadReject) {
      throw new Error(this.updateLeadReject);
    }
    await this.getLead(leadId);
    const current = this.leadProfiles.get(leadId) ?? {};
    const base = this.getGlobalLeads().find((lead) => lead.id === leadId);
    const from = current.status ?? base?.status ?? "candidate";
    const to = input.status ?? from;
    if (!canMoveLead(from, to)) {
      throw new Error(
        `invalid: Lead status transition ${relationshipLabel(from)} -> ${relationshipLabel(to)} is not allowed`,
      );
    }
    // `update_lead` is a full-profile upsert on the relay: every editable
    // column is overwritten from the request, and a field the caller omits
    // binds NULL and wipes the stored value. Only `status` falls back to the
    // previous value. Spreading `input` over `current` would preserve omitted
    // fields and make demo disagree with live, so each field is written
    // explicitly. A caller that sends a partial profile must lose data here
    // too, otherwise the demo path and Playwright are blind to the one hazard
    // this whole edit flow is built around.
    this.leadProfiles.set(leadId, {
      status: to,
      website: input.website,
      email: input.email,
      phone: input.phone,
      linkedinUrl: input.linkedinUrl,
      contactName: input.contactName,
      contactTitle: input.contactTitle,
      owner: input.owner,
      score: input.score,
      notes: input.notes,
      updatedAt: new Date().toISOString(),
    });
    return this.getLead(leadId);
  }

  async getPipelineColumns(): Promise<PipelineColumn[]> {
    return Promise.all(
      PIPELINE_COLUMN_STATUSES.map(async (status) => {
        const page = await this.getLeads({
          scope: "global",
          status,
          page: 1,
          pageSize: 100,
        });
        return { status, total: page.total, leads: page.leads };
      }),
    );
  }

  async getVerticals(industryId: string): Promise<Vertical[]> {
    const canonicalIndustry = canonicalIndustryId(industryId);
    return clone(
      FIXTURE_VERTICAL_DETAILS.filter(
        (item) => item.industryId === canonicalIndustry,
      ).map(({ campaigns: _campaigns, ...vertical }) => vertical),
    );
  }

  async getVertical(
    industryId: string,
    verticalId: string,
  ): Promise<VerticalDetail> {
    const canonicalIndustry = canonicalIndustryId(industryId);
    const canonicalVertical = canonicalVerticalId(
      canonicalIndustry,
      verticalId,
    );
    const vertical = FIXTURE_VERTICAL_DETAILS.find(
      (item) =>
        item.industryId === canonicalIndustry && item.id === canonicalVertical,
    );
    if (!vertical) {
      throw new Error(
        `Unknown discovery vertical: ${industryId}/${verticalId}`,
      );
    }
    const campaigns = [...this.campaigns.values()]
      .filter(
        (campaign) =>
          campaign.industryId === canonicalIndustry &&
          campaign.verticalId === canonicalVertical,
      )
      .map((campaign) => toCampaignSummary(campaign));
    return clone({ ...vertical, campaigns });
  }

  async getFields(): Promise<ProfessionalField[]> {
    return clone(FIXTURE_FIELDS);
  }

  async getRoles(fieldId: string): Promise<ProfessionalRole[]> {
    return clone(
      FIXTURE_ROLE_DETAILS.filter((role) => role.fieldId === fieldId).map(
        ({ campaigns: _campaigns, ...role }) => role,
      ),
    );
  }

  async getRole(
    fieldId: string,
    roleId: string,
  ): Promise<ProfessionalRoleDetail> {
    const role = FIXTURE_ROLE_DETAILS.find(
      (candidate) => candidate.fieldId === fieldId && candidate.id === roleId,
    );
    if (!role) {
      throw new Error(`Unknown discovery role: ${fieldId}/${roleId}`);
    }
    const campaigns = [...this.campaigns.values()]
      .filter(
        (campaign) =>
          campaign.targetType === "individual" &&
          campaign.fieldId === fieldId &&
          campaign.roleId === roleId,
      )
      .map((campaign) => toCampaignSummary(campaign));
    return clone({ ...role, campaigns });
  }

  async getCampaign(campaignId: string): Promise<CampaignDetail> {
    return clone(this.requireCampaign(campaignId));
  }

  async getLeads(scope: LeadScope): Promise<LeadPage> {
    if (this.emptyLeads && scope.scope !== "campaign") {
      return {
        leads: [],
        total: 0,
        page: 1,
        pageSize: scope.pageSize ?? 25,
        hasNextPage: false,
      };
    }
    const scopeKind = scope.scope ?? scope.kind ?? scope.type ?? "global";
    const sourceLeads =
      scopeKind === "campaign"
        ? clone(this.campaignLeads.get(scope.campaignId ?? "") ?? [])
        : this.getGlobalLeads();
    let leads = sourceLeads.map((lead) => {
      const profile = this.leadProfiles.get(lead.id);
      return profile ? { ...lead, ...profile } : lead;
    });
    leads = leads.filter((lead) => {
      if (scopeKind === "campaign" && scope.campaignId) {
        return lead.campaignIds.includes(scope.campaignId);
      }
      return true;
    });
    if (scope.industryId)
      leads = leads.filter((lead) => lead.industryId === scope.industryId);
    if (scope.verticalId)
      leads = leads.filter((lead) => lead.verticalId === scope.verticalId);
    if (scope.targetType)
      leads = leads.filter((lead) =>
        scope.targetType === "individual"
          ? lead.entityType === "person"
          : lead.entityType !== "person",
      );
    if (scope.fieldId)
      leads = leads.filter((lead) => lead.industryId === scope.fieldId);
    if (scope.roleId)
      leads = leads.filter((lead) => lead.verticalId === scope.roleId);
    if (scope.status)
      leads = leads.filter((lead) => lead.status === scope.status);
    if (scope.search) {
      const query = scope.search.toLowerCase();
      leads = leads.filter((lead) =>
        [
          lead.companyName,
          lead.location,
          lead.contactName,
          lead.personName,
          lead.roleName,
          lead.email,
        ]
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

  async getOutreach(campaignId: string): Promise<OutreachDraft[]> {
    this.requireCampaign(campaignId);
    return clone(this.campaignOutreach.get(campaignId) ?? []);
  }

  async createOutreach(campaignId: string): Promise<OutreachDraft> {
    const campaign = this.requireCampaign(campaignId);
    const leads = this.campaignLeads.get(campaignId) ?? [];
    const items = this.campaignOutreach.get(campaignId) ?? [];
    const lead =
      leads.find((candidate) =>
        items.every((item) => item.leadId !== candidate.id),
      ) ?? leads[0];
    if (!lead) throw new Error("Create outreach after discovering a lead.");
    const seeded = seedOutreach(campaign, [lead])[0];
    const created: OutreachDraft = {
      ...seeded,
      id: `${seeded.id}-${items.length + 1}`,
      status: "Draft",
    };
    items.unshift(created);
    this.campaignOutreach.set(campaignId, items);
    return clone(created);
  }

  async updateOutreachStatus(
    campaignId: string,
    outreachId: string,
    status: OutreachStatus,
  ): Promise<OutreachDraft> {
    this.requireCampaign(campaignId);
    const items = this.campaignOutreach.get(campaignId) ?? [];
    const item = items.find((candidate) => candidate.id === outreachId);
    if (!item) throw new Error(`Unknown outreach draft: ${outreachId}`);
    item.status = status;
    return clone(item);
  }

  async getConversations(campaignId: string): Promise<ConversationThread[]> {
    this.requireCampaign(campaignId);
    return clone(this.campaignConversations.get(campaignId) ?? []);
  }

  async markConversationRead(
    campaignId: string,
    conversationId: string,
  ): Promise<ConversationThread> {
    this.requireCampaign(campaignId);
    const conversation = this.requireConversation(campaignId, conversationId);
    conversation.unread = false;
    return clone(conversation);
  }

  async sendConversationReply(
    campaignId: string,
    conversationId: string,
    body: string,
  ): Promise<ConversationThread> {
    this.requireCampaign(campaignId);
    const conversation = this.requireConversation(campaignId, conversationId);
    const content = body.trim();
    if (!content) throw new Error("A reply cannot be empty.");
    conversation.messages.push({
      id: `${conversation.id}-message-${conversation.messages.length + 1}`,
      direction: "outbound",
      body: content,
      sentAt: "2026-08-01T10:15:00.000Z",
    });
    conversation.unread = false;
    return clone(conversation);
  }

  async createCampaign(input: CampaignDraft): Promise<CampaignDetail> {
    const targetType = input.targetType ?? "business";
    const industry = FIXTURE_INDUSTRIES.find(
      (item) => item.id === input.industryId,
    );
    const vertical = FIXTURE_VERTICAL_DETAILS.find(
      (item) =>
        item.industryId === input.industryId && item.id === input.verticalId,
    );
    const field = FIXTURE_FIELDS.find(
      (item) => item.id === (input.fieldId ?? input.industryId),
    );
    const role = FIXTURE_ROLE_DETAILS.find(
      (item) =>
        item.fieldId === (input.fieldId ?? input.industryId) &&
        item.id === (input.roleId ?? input.verticalId),
    );
    if (targetType === "business" && (!industry || !vertical)) {
      throw new Error(
        `Unknown discovery vertical: ${input.industryId}/${input.verticalId}`,
      );
    }
    if (targetType === "individual" && (!field || !role)) {
      throw new Error(
        `Unknown discovery role: ${input.fieldId ?? input.industryId}/${input.roleId ?? input.verticalId}`,
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
      targetType,
      industryId:
        targetType === "individual" ? (field?.id ?? "") : (industry?.id ?? ""),
      verticalId:
        targetType === "individual" ? (role?.id ?? "") : (vertical?.id ?? ""),
      industryName:
        targetType === "individual"
          ? (field?.name ?? "")
          : (industry?.name ?? ""),
      verticalName:
        targetType === "individual"
          ? (role?.name ?? "")
          : (vertical?.name ?? ""),
      fieldId: targetType === "individual" ? field?.id : undefined,
      roleId: targetType === "individual" ? role?.id : undefined,
      fieldName: targetType === "individual" ? field?.name : undefined,
      roleName: targetType === "individual" ? role?.name : undefined,
      location: input.location.trim(),
      description: input.description,
      status: "ready",
      target,
      targetLeads: target,
      leadCount: 0,
      createdAt,
      updatedAt: createdAt,
      sourceConfig: resolveSourceConfig(
        input.sourceConfig ??
          (targetType === "individual"
            ? {
                mode: "waterfall",
                order: [
                  "linkedin_company_search",
                  "brave_search",
                  "exa_search",
                ],
              }
            : undefined),
      ),
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
    this.campaignOutreach.set(id, []);
    this.campaignConversations.set(id, []);
    return clone(campaign);
  }

  async approveCampaignBudget(campaignId: string): Promise<CampaignDetail> {
    const campaign = this.requireCampaign(campaignId);
    const approvedNanousd = (BigInt(campaign.target) * 50_000_000n).toString();
    campaign.budget = {
      state: "active",
      payerPubkey: "fixture",
      approvedNanousd,
      spentNanousd: "0",
      reservedNanousd: "0",
      remainingNanousd: approvedNanousd,
      pricePerRetainedLeadNanousd: "50000000",
      approvedAt: campaign.updatedAt,
    };
    return clone(campaign);
  }

  async pauseCampaignBudget(campaignId: string): Promise<CampaignDetail> {
    const campaign = this.requireCampaign(campaignId);
    if (campaign.budget) campaign.budget.state = "paused";
    return clone(campaign);
  }

  async revokeCampaignBudget(campaignId: string): Promise<CampaignDetail> {
    const campaign = this.requireCampaign(campaignId);
    if (campaign.budget) campaign.budget.state = "revoked";
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
      campaign.targetType === "individual"
        ? FIXTURE_PEOPLE_LEADS
        : campaignId === CAMPAIGN_FIXTURE.id
          ? FIXTURE_CAMPAIGN_LEADS
          : campaignId === FIXTURE_PRO_SERVICES_CAMPAIGN.id
            ? FIXTURE_PRO_SERVICES_LEADS
            : FIXTURE_GLOBAL_LEADS.filter(
                (lead) => lead.entityType !== "person",
              );
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

  private requireConversation(
    campaignId: string,
    conversationId: string,
  ): ConversationThread {
    const conversation = (
      this.campaignConversations.get(campaignId) ?? []
    ).find((candidate) => candidate.id === conversationId);
    if (!conversation) {
      throw new Error(`Unknown discovery conversation: ${conversationId}`);
    }
    return conversation;
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
      };
    case "loading":
      return { feature: "discovery_engine", state: "loading" };
    case "error":
      return { feature: "discovery_engine", state: "error" };
    default:
      return {
        feature: "discovery_engine",
        state: "entitled",
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
