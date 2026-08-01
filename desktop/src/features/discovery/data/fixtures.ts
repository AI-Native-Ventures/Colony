import type { DiscoverySource } from "../sourceConfig";
import {
  DEFAULT_SOURCE_CONFIG,
  DISCOVERY_SOURCE_LABELS,
} from "../sourceConfig";
import type {
  CampaignDetail,
  CampaignSummary,
  DiscoveryRun,
  Industry,
  Lead,
  Vertical,
  VerticalDetail,
} from "../types";

export const FIXTURE_INDUSTRIES: Industry[] = [
  {
    id: "automotive",
    slug: "automotive",
    name: "Automotive",
    description: "Businesses that keep people and vehicles moving.",
    imageKey: "industry.automotive",
    verticalCount: 3,
    leadCount: 5,
    campaignCount: 1,
    status: "active",
  },
  {
    id: "professional-services",
    slug: "professional-services",
    name: "Professional Services",
    description: "Specialist firms and trusted advisors.",
    imageKey: "industry.professional-services",
    verticalCount: 0,
    leadCount: 0,
    campaignCount: 0,
    status: "available",
  },
  {
    id: "agriculture",
    slug: "agriculture",
    name: "Agriculture",
    description: "Producers, suppliers, and agricultural operators.",
    imageKey: "industry.agriculture",
    verticalCount: 0,
    leadCount: 0,
    campaignCount: 0,
    status: "available",
  },
  {
    id: "aviation-airlines",
    slug: "aviation-airlines",
    name: "Aviation & Airlines",
    description: "The businesses behind safe, reliable air travel.",
    imageKey: "industry.aviation-airlines",
    verticalCount: 0,
    leadCount: 0,
    campaignCount: 0,
    status: "available",
  },
];

export const FIXTURE_VERTICALS: Vertical[] = [
  {
    id: "auto-repair",
    slug: "auto-repair",
    industryId: "automotive",
    name: "Auto Repair",
    description: "Independent workshops and specialist repair centres.",
    imageKey: "vertical.auto-repair",
    campaignCount: 1,
    leadCount: 5,
    status: "active",
  },
  {
    id: "car-dealerships",
    slug: "car-dealerships",
    industryId: "automotive",
    name: "Car Dealerships",
    imageKey: "vertical.car-dealerships",
    campaignCount: 0,
    leadCount: 0,
    status: "available",
  },
  {
    id: "collision-repair",
    slug: "collision-repair",
    industryId: "automotive",
    name: "Collision Repair",
    imageKey: "vertical.collision-repair",
    campaignCount: 0,
    leadCount: 0,
    status: "available",
  },
];

const CAMPAIGN_ID = "auto-repair-johannesburg";
const CAMPAIGN_CREATED_AT = "2026-08-01T08:00:00.000Z";

export const FIXTURE_CAMPAIGN_SUMMARY: CampaignSummary = {
  id: CAMPAIGN_ID,
  name: "Auto Repair — Johannesburg",
  industryId: "automotive",
  verticalId: "auto-repair",
  industryName: "Automotive",
  verticalName: "Auto Repair",
  location: "Johannesburg",
  description: "Find independent auto repair businesses in Johannesburg.",
  status: "ready",
  target: 10,
  targetLeads: 10,
  leadCount: 5,
  createdAt: CAMPAIGN_CREATED_AT,
  updatedAt: CAMPAIGN_CREATED_AT,
};

export const FIXTURE_CAMPAIGN: CampaignDetail = {
  ...FIXTURE_CAMPAIGN_SUMMARY,
  sourceConfig: {
    mode: DEFAULT_SOURCE_CONFIG.mode,
    order: [...DEFAULT_SOURCE_CONFIG.order],
  },
  metrics: {
    companiesFound: 5,
    contactsFound: 6,
    emailsFound: 4,
    missingWebsites: 1,
  },
};

function fixtureLead(
  id: string,
  companyName: string,
  location: string,
  source: DiscoverySource,
  details: Partial<Lead> = {},
): Lead {
  return {
    id,
    companyName,
    company: companyName,
    contacts: 1,
    location,
    source,
    sourceLabel: DISCOVERY_SOURCE_LABELS[source],
    score: 80,
    industryId: "automotive",
    verticalId: "auto-repair",
    campaignIds: [CAMPAIGN_ID],
    status: "new",
    addedAt: "2026-08-01T08:30:00.000Z",
    ...details,
  };
}

export const FIXTURE_CAMPAIGN_LEADS: Lead[] = [
  fixtureLead(
    "lead-001",
    "Rosebank Auto Care",
    "Rosebank, Johannesburg",
    "google_maps",
    {
      contactName: "Mpho Dlamini",
      contactTitle: "Owner",
      phone: "+27 11 555 0101",
      email: "hello@rosebankautocare.example",
      website: "https://rosebankautocare.example",
      score: 94,
      status: "qualified",
    },
  ),
  fixtureLead(
    "lead-002",
    "Soweto Motor Works",
    "Soweto, Johannesburg",
    "dataforseo",
    {
      contactName: "Thabo Mokoena",
      contactTitle: "Workshop Manager",
      phone: "+27 11 555 0102",
      score: 89,
    },
  ),
  fixtureLead(
    "lead-003",
    "Randburg Auto Clinic",
    "Randburg, Johannesburg",
    "brave_search",
    {
      contactName: "Lerato Ndlovu",
      email: "team@randburgautoclinic.example",
      website: "https://randburgautoclinic.example",
      score: 86,
      status: "enriched",
    },
  ),
  fixtureLead(
    "lead-004",
    "Midrand Service Centre",
    "Midrand, Johannesburg",
    "openstreetmap",
    {
      contacts: 2,
      phone: "+27 11 555 0104",
      score: 78,
    },
  ),
  fixtureLead(
    "lead-005",
    "Fourways Garage",
    "Fourways, Johannesburg",
    "directories",
    {
      contacts: 1,
      score: 72,
      status: "new",
    },
  ),
];

export const FIXTURE_GLOBAL_LEADS: Lead[] = [
  ...FIXTURE_CAMPAIGN_LEADS,
  fixtureLead(
    "lead-006",
    "Pretoria Fleet Fix",
    "Pretoria, Gauteng",
    "google_maps",
    {
      campaignIds: [],
      location: "Pretoria, Gauteng",
      score: 67,
      status: "enriched",
    },
  ),
  fixtureLead(
    "lead-007",
    "East Rand Auto",
    "Boksburg, Gauteng",
    "brave_search",
    {
      campaignIds: [],
      location: "Boksburg, Gauteng",
      score: 61,
      status: "new",
    },
  ),
];

export const FIXTURE_VERTICAL_DETAILS: VerticalDetail[] = [
  {
    ...FIXTURE_VERTICALS[0],
    campaigns: [FIXTURE_CAMPAIGN_SUMMARY],
  },
  {
    ...FIXTURE_VERTICALS[1],
    campaigns: [],
  },
  {
    ...FIXTURE_VERTICALS[2],
    campaigns: [],
  },
];

export function createIdleDiscoveryRun(campaign: CampaignDetail): DiscoveryRun {
  return {
    id: `${campaign.id}-run-0001`,
    campaignId: campaign.id,
    status: "idle",
    phase: "initializing",
    target: campaign.target,
    discovered: 0,
    stored: 0,
    rejected: 0,
    duplicates: 0,
    completion: 0,
    targetReached: false,
    sourceMetrics: campaign.sourceConfig.order.map((source) => ({
      source,
      status: "pending",
      discovered: 0,
      stored: 0,
      rejected: 0,
      duplicates: 0,
      quality: 0,
      acceptance: 0,
    })),
  };
}

export const INDUSTRY_FIXTURES = FIXTURE_INDUSTRIES;
export const VERTICAL_FIXTURES = FIXTURE_VERTICALS;
export const CAMPAIGN_FIXTURE = FIXTURE_CAMPAIGN;
export const CAMPAIGN_LEAD_FIXTURES = FIXTURE_CAMPAIGN_LEADS;
export const GLOBAL_LEAD_FIXTURES = FIXTURE_GLOBAL_LEADS;
