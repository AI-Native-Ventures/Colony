import type { DiscoverySource } from "../sourceConfig";
import {
  DEFAULT_SOURCE_CONFIG,
  DISCOVERY_SOURCE_LABELS,
} from "../sourceConfig";
import { BUSINESS_TAXONOMY } from "./businessTaxonomy/index";
import type {
  CampaignDetail,
  CampaignSummary,
  DiscoveryRun,
  Industry,
  Lead,
  ProfessionalField,
  ProfessionalRole,
  ProfessionalRoleDetail,
  Vertical,
  VerticalDetail,
} from "../types";

const DEMO_VERTICAL_LEAD_COUNTS = new Map<string, number>([
  ["automotive/auto-repair", 10],
  ["professional-services/accounting-financial-advisory", 308],
]);

export const FIXTURE_INDUSTRIES: Industry[] = BUSINESS_TAXONOMY.map(
  (industry) => {
    const leadCount = industry.verticals.reduce(
      (total, vertical) =>
        total +
        (DEMO_VERTICAL_LEAD_COUNTS.get(`${industry.slug}/${vertical.slug}`) ??
          0),
      0,
    );
    return {
      id: industry.slug,
      slug: industry.slug,
      name: industry.name,
      description:
        industry.description ??
        `Discover companies across ${industry.name.toLowerCase()} verticals.`,
      imageKey: `industry.${industry.slug}`,
      verticalCount: industry.verticals.length,
      leadCount,
      campaignCount: leadCount > 0 ? 1 : 0,
      status: leadCount > 0 ? "active" : "available",
    };
  },
);

export const FIXTURE_VERTICALS: Vertical[] = BUSINESS_TAXONOMY.flatMap(
  (industry) =>
    industry.verticals.map((vertical) => {
      const leadCount =
        DEMO_VERTICAL_LEAD_COUNTS.get(`${industry.slug}/${vertical.slug}`) ?? 0;
      return {
        id: vertical.slug,
        slug: vertical.slug,
        industryId: industry.slug,
        name: vertical.name,
        description:
          vertical.description ??
          `Discover businesses in the ${vertical.name} vertical.`,
        imageKey: `industry.${industry.slug}`,
        campaignCount: leadCount > 0 ? 1 : 0,
        leadCount,
        status: leadCount > 0 ? "active" : "available",
      };
    }),
);

const FIELD_DEFINITIONS = [
  {
    id: "engineering",
    name: "Engineering",
    imageKey: "field.engineering",
    roles: [
      "Frontend Engineer",
      "Backend Engineer",
      "Full Stack Engineer",
      "Mobile Engineer",
      "DevOps Engineer",
      "Security Engineer",
      "Engineering Manager",
      "Chief Technology Officer",
    ],
  },
  {
    id: "marketing",
    name: "Marketing",
    imageKey: "field.marketing",
    roles: [
      "Marketing Director",
      "Growth Marketer",
      "Content Strategist",
      "Brand Manager",
      "Demand Generation Manager",
      "Social Media Manager",
      "Chief Marketing Officer",
    ],
  },
  {
    id: "medicine",
    name: "Medicine",
    imageKey: "field.medicine",
    roles: [
      "General Practitioner",
      "Medical Specialist",
      "Nurse Practitioner",
      "Practice Manager",
      "Clinical Director",
      "Hospital Administrator",
    ],
  },
  {
    id: "law",
    name: "Law",
    imageKey: "field.law",
    roles: [
      "Attorney",
      "Legal Counsel",
      "Managing Partner",
      "Compliance Officer",
      "Paralegal",
    ],
  },
  {
    id: "finance",
    name: "Finance",
    imageKey: "field.finance",
    roles: [
      "Financial Analyst",
      "Investment Manager",
      "Finance Director",
      "Treasury Manager",
      "Controller",
      "Chief Financial Officer",
    ],
  },
  {
    id: "sales",
    name: "Sales",
    imageKey: "field.sales",
    roles: [
      "Account Executive",
      "Sales Development Representative",
      "Sales Manager",
      "Regional Sales Director",
      "Partnerships Manager",
      "Revenue Operations Manager",
      "Chief Revenue Officer",
    ],
  },
  {
    id: "human-resources",
    name: "Human Resources",
    imageKey: "field.human-resources",
    roles: [
      "Recruiter",
      "People Operations Manager",
      "HR Business Partner",
      "Talent Director",
      "Chief People Officer",
    ],
  },
  {
    id: "accounting",
    name: "Accounting",
    imageKey: "field.accounting",
    roles: [
      "Accountant",
      "Auditor",
      "Tax Manager",
      "Accounting Manager",
      "Audit Partner",
    ],
  },
  {
    id: "agriculture",
    name: "Agriculture",
    imageKey: "field.agriculture",
    roles: [
      "Agronomist",
      "Farm Manager",
      "Agricultural Engineer",
      "Food Production Manager",
    ],
  },
  {
    id: "politics",
    name: "Politics",
    imageKey: "field.politics",
    roles: [
      "Policy Advisor",
      "Public Affairs Director",
      "Campaign Manager",
      "Government Relations Manager",
    ],
  },
  {
    id: "education",
    name: "Education",
    imageKey: "field.education",
    roles: [
      "Teacher",
      "Lecturer",
      "School Principal",
      "Academic Director",
      "Education Consultant",
    ],
  },
  {
    id: "design",
    name: "Design",
    imageKey: "field.design",
    roles: [
      "Product Designer",
      "UX Designer",
      "Creative Director",
      "Graphic Designer",
      "Design Lead",
    ],
  },
  {
    id: "research",
    name: "Research",
    imageKey: "field.research",
    roles: [
      "Research Scientist",
      "Market Researcher",
      "Research Director",
      "Laboratory Manager",
    ],
  },
  {
    id: "consulting",
    name: "Consulting",
    imageKey: "field.consulting",
    roles: [
      "Management Consultant",
      "Strategy Consultant",
      "Principal Consultant",
      "Consulting Partner",
      "Transformation Director",
    ],
  },
  {
    id: "operations",
    name: "Operations",
    imageKey: "field.operations",
    roles: [
      "Operations Manager",
      "Supply Chain Manager",
      "Logistics Director",
      "Procurement Manager",
      "General Manager",
      "Chief Operating Officer",
    ],
  },
  {
    id: "product-management",
    name: "Product Management",
    imageKey: "field.product-management",
    roles: [
      "Product Manager",
      "Senior Product Manager",
      "Product Director",
      "Head of Product",
      "Chief Product Officer",
    ],
  },
  {
    id: "customer-success",
    name: "Customer Success",
    imageKey: "field.customer-success",
    roles: [
      "Customer Success Manager",
      "Implementation Manager",
      "Customer Experience Director",
      "Support Manager",
      "VP Customer Success",
    ],
  },
  {
    id: "data-science",
    name: "Data Science",
    imageKey: "field.data-science",
    roles: [
      "Data Scientist",
      "Machine Learning Engineer",
      "Analytics Director",
      "Head of Data",
    ],
  },
] as const;

function fixtureSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const PEOPLE_CAMPAIGN_ID = "marketing-directors-united-states";

export const FIXTURE_FIELDS: ProfessionalField[] = FIELD_DEFINITIONS.map(
  (field) => {
    const active = field.id === "marketing";
    return {
      id: field.id,
      slug: field.id,
      name: field.name,
      description: `Professional roles across ${field.name.toLowerCase()}.`,
      imageKey: field.imageKey,
      roleCount: field.roles.length,
      leadCount: active ? 8 : 0,
      campaignCount: active ? 1 : 0,
      status: active ? "active" : "available",
    };
  },
);

export const FIXTURE_ROLES: ProfessionalRole[] = FIELD_DEFINITIONS.flatMap(
  (field) =>
    field.roles.map((roleName) => {
      const id = fixtureSlug(roleName);
      const active = field.id === "marketing" && id === "marketing-director";
      return {
        id,
        slug: id,
        fieldId: field.id,
        name: roleName,
        description: `${roleName} professionals working across modern organizations.`,
        imageKey: field.imageKey,
        campaignCount: active ? 1 : 0,
        leadCount: active ? 8 : 0,
        status: active ? "active" : "available",
      };
    }),
);

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
  leadCount: 10,
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
    companiesFound: 10,
    contactsFound: 11,
    emailsFound: 3,
    missingWebsites: 7,
  },
};

export const FIXTURE_PEOPLE_CAMPAIGN_SUMMARY: CampaignSummary = {
  id: PEOPLE_CAMPAIGN_ID,
  name: "Marketing Directors — United States",
  targetType: "individual",
  industryId: "marketing",
  verticalId: "marketing-director",
  industryName: "Marketing",
  verticalName: "Marketing Director",
  fieldId: "marketing",
  roleId: "marketing-director",
  fieldName: "Marketing",
  roleName: "Marketing Director",
  location: "United States",
  description: "Find senior marketing leaders at growing US companies.",
  status: "ready",
  target: 25,
  targetLeads: 25,
  leadCount: 8,
  createdAt: CAMPAIGN_CREATED_AT,
  updatedAt: CAMPAIGN_CREATED_AT,
};

export const FIXTURE_PEOPLE_CAMPAIGN: CampaignDetail = {
  ...FIXTURE_PEOPLE_CAMPAIGN_SUMMARY,
  sourceConfig: {
    mode: "waterfall",
    order: ["linkedin_company_search", "brave_search", "exa_search"],
  },
  metrics: {
    companiesFound: 7,
    contactsFound: 8,
    emailsFound: 6,
    missingWebsites: 0,
  },
};

export const FIXTURE_PRO_SERVICES_CAMPAIGN_SUMMARY: CampaignSummary = {
  id: "accounting-financial-advisory-united-states",
  name: "Accounting & Financial Advisory — United States",
  targetType: "business",
  industryId: "professional-services",
  verticalId: "accounting-financial-advisory",
  industryName: "Professional Services",
  verticalName: "Accounting & Financial Advisory",
  location: "United States",
  description:
    "Find accounting and financial advisory firms across the United States.",
  status: "completed",
  target: 300,
  targetLeads: 300,
  leadCount: 308,
  createdAt: CAMPAIGN_CREATED_AT,
  updatedAt: CAMPAIGN_CREATED_AT,
};

export const FIXTURE_PRO_SERVICES_CAMPAIGN: CampaignDetail = {
  ...FIXTURE_PRO_SERVICES_CAMPAIGN_SUMMARY,
  sourceConfig: {
    mode: DEFAULT_SOURCE_CONFIG.mode,
    order: [...DEFAULT_SOURCE_CONFIG.order],
  },
  metrics: {
    companiesFound: 308,
    contactsFound: 308,
    emailsFound: 205,
    missingWebsites: 51,
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
    status: "candidate",
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
      status: "accepted",
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
      status: "dormant",
    },
  ),
  fixtureLead(
    "lead-006",
    "Oakdene Auto Service",
    "Oakdene, Johannesburg",
    "google_maps",
    {
      contactName: "Naledi Maseko",
      website: "https://oakdeneautoservice.example",
      score: 76,
    },
  ),
  fixtureLead(
    "lead-007",
    "Alexandra Motor Hub",
    "Alexandra, Johannesburg",
    "dataforseo",
    {
      contactName: "Sipho Zulu",
      phone: "+27 11 555 0107",
      score: 74,
    },
  ),
  fixtureLead(
    "lead-008",
    "Kensington Auto Works",
    "Kensington, Johannesburg",
    "brave_search",
    {
      contactName: "Ayesha Khan",
      email: "hello@kensingtonautoworks.example",
      score: 71,
    },
  ),
  fixtureLead(
    "lead-009",
    "Northcliff Garage",
    "Northcliff, Johannesburg",
    "exa_search",
    {
      contactName: "Palesa Mthembu",
      score: 69,
    },
  ),
  fixtureLead(
    "lead-010",
    "Lenasia Motor Clinic",
    "Lenasia, Johannesburg",
    "openstreetmap",
    {
      contactName: "Yusuf Patel",
      phone: "+27 11 555 0110",
      score: 66,
    },
  ),
];

function fixturePerson(
  id: string,
  personName: string,
  currentCompany: string,
  location: string,
  details: Partial<Lead> = {},
): Lead {
  return {
    id,
    entityType: "person",
    companyName: currentCompany,
    company: currentCompany,
    contactName: personName,
    personName,
    contactTitle: "Marketing Director",
    headline: `Marketing Director at ${currentCompany}`,
    roleName: "Marketing Director",
    currentCompany,
    seniority: "Director",
    contacts: 1,
    location,
    source: "linkedin_company_search",
    sourceLabel: DISCOVERY_SOURCE_LABELS.linkedin_company_search,
    linkedinUrl: `https://www.linkedin.com/in/${id}`,
    score: 88,
    industryId: "marketing",
    verticalId: "marketing-director",
    campaignIds: [PEOPLE_CAMPAIGN_ID],
    status: "candidate",
    addedAt: "2026-08-01T09:00:00.000Z",
    ...details,
  };
}

export const FIXTURE_PEOPLE_LEADS: Lead[] = [
  fixturePerson(
    "maya-thompson",
    "Maya Thompson",
    "Northstar Health",
    "Austin, Texas",
    {
      email: "maya.thompson@northstar.example",
      score: 96,
    },
  ),
  fixturePerson(
    "daniel-lee",
    "Daniel Lee",
    "Vertex Commerce",
    "New York, New York",
    {
      contactTitle: "VP of Marketing",
      headline: "VP of Marketing at Vertex Commerce",
      roleName: "VP of Marketing",
      seniority: "VP",
      email: "daniel.lee@vertex.example",
      score: 94,
    },
  ),
  fixturePerson(
    "sofia-martinez",
    "Sofia Martinez",
    "Brightline Energy",
    "Miami, Florida",
    {
      email: "sofia.martinez@brightline.example",
      score: 92,
    },
  ),
  fixturePerson(
    "jordan-williams",
    "Jordan Williams",
    "Arcadia Software",
    "Seattle, Washington",
    {
      contactTitle: "Head of Growth",
      headline: "Head of Growth at Arcadia Software",
      roleName: "Head of Growth",
      seniority: "Head",
      score: 90,
    },
  ),
  fixturePerson(
    "aisha-patel",
    "Aisha Patel",
    "Common Ground Finance",
    "Chicago, Illinois",
    {
      email: "aisha.patel@commonground.example",
      score: 89,
    },
  ),
  fixturePerson(
    "ethan-brooks",
    "Ethan Brooks",
    "Harbor Logistics",
    "Boston, Massachusetts",
    { score: 86 },
  ),
  fixturePerson(
    "nia-robinson",
    "Nia Robinson",
    "Solstice Learning",
    "Denver, Colorado",
    {
      email: "nia.robinson@solstice.example",
      score: 84,
    },
  ),
  fixturePerson(
    "lucas-garcia",
    "Lucas Garcia",
    "Evergreen Foods",
    "Portland, Oregon",
    {
      email: "lucas.garcia@evergreen.example",
      score: 82,
    },
  ),
];

export const FIXTURE_PRO_SERVICES_LEADS: Lead[] = Array.from(
  { length: 308 },
  (_, index) => {
    const number = index + 1;
    const source =
      DEFAULT_SOURCE_CONFIG.order[index % DEFAULT_SOURCE_CONFIG.order.length];
    return fixtureLead(
      `accounting-practice-${number}`,
      `Accounting Practice ${String(number).padStart(3, "0")}`,
      ["New York", "Chicago", "Austin", "Seattle"][index % 4],
      source,
      {
        industryId: "professional-services",
        verticalId: "accounting-financial-advisory",
        campaignIds: [FIXTURE_PRO_SERVICES_CAMPAIGN_SUMMARY.id],
        email:
          index < 205
            ? `hello${number}@accounting-practice.example`
            : undefined,
        website:
          index < 257
            ? `https://accounting-practice-${number}.example`
            : undefined,
        score: 70 + (index % 27),
        status: index % 4 === 0 ? "accepted" : "candidate",
      },
    );
  },
);

export const FIXTURE_GLOBAL_LEADS: Lead[] = [
  ...FIXTURE_CAMPAIGN_LEADS,
  ...FIXTURE_PEOPLE_LEADS,
  ...FIXTURE_PRO_SERVICES_LEADS,
  fixtureLead(
    "lead-011",
    "Pretoria Fleet Fix",
    "Pretoria, Gauteng",
    "google_maps",
    {
      campaignIds: [],
      location: "Pretoria, Gauteng",
      score: 67,
      status: "candidate",
    },
  ),
  fixtureLead(
    "lead-012",
    "East Rand Auto",
    "Boksburg, Gauteng",
    "brave_search",
    {
      campaignIds: [],
      location: "Boksburg, Gauteng",
      score: 61,
      status: "candidate",
    },
  ),
];

export const FIXTURE_VERTICAL_DETAILS: VerticalDetail[] = FIXTURE_VERTICALS.map(
  (vertical) => ({
    ...vertical,
    campaigns:
      vertical.id === "auto-repair"
        ? [FIXTURE_CAMPAIGN_SUMMARY]
        : vertical.id === "accounting-financial-advisory"
          ? [FIXTURE_PRO_SERVICES_CAMPAIGN_SUMMARY]
          : [],
  }),
);

export const FIXTURE_ROLE_DETAILS: ProfessionalRoleDetail[] = FIXTURE_ROLES.map(
  (role) => ({
    ...role,
    campaigns:
      role.id === "marketing-director" ? [FIXTURE_PEOPLE_CAMPAIGN_SUMMARY] : [],
  }),
);

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
