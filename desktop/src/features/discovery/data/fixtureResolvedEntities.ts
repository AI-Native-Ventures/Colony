import type {
  DiscoveryEntityRef,
  ResolvedDiscoveryEntity,
  ResolvedDiscoveryLead,
  ResolvedDiscoveryLeadStatus,
} from "./DiscoveryDataSource";
import { FIXTURE_INDUSTRIES, FIXTURE_VERTICALS } from "./fixtures";

/**
 * Deterministic `resolve_entities` answers for fixture builds.
 *
 * The fixture Discovery workspace has no relay, so Campaign, Lead and run IDs
 * in a message are opaque UUIDs that no fixture row was created with. Rather
 * than resolving those to "not available" and leaving Playwright with nothing
 * to photograph, every well-formed reference resolves to a stable row picked
 * from these seeds by hashing the reference ID: the same ID always renders the
 * same tile, and two different IDs render two different tiles.
 */

type FixtureLeadSeed = {
  name: string;
  city: string;
  ratingHundredths: number;
  reviewsCount: number;
  status: ResolvedDiscoveryLeadStatus;
  website: string;
};

const FIXTURE_LEAD_SEEDS: readonly FixtureLeadSeed[] = [
  {
    name: "Atlantic Plumbing",
    city: "Sea Point",
    ratingHundredths: 470,
    reviewsCount: 212,
    status: "candidate",
    website: "https://atlanticplumb.example",
  },
  {
    name: "Drain Doctors",
    city: "Claremont",
    ratingHundredths: 490,
    reviewsCount: 88,
    status: "accepted",
    website: "https://draindoctors.example",
  },
  {
    name: "Peninsula Geysers",
    city: "Wynberg",
    ratingHundredths: 430,
    reviewsCount: 41,
    status: "qualified",
    website: "https://peninsulageysers.example",
  },
  {
    name: "City Bowl Plumbers",
    city: "Gardens",
    ratingHundredths: 450,
    reviewsCount: 61,
    status: "candidate",
    website: "https://citybowlplumbers.example",
  },
  {
    name: "Southern Suburbs Plumbing",
    city: "Constantia",
    ratingHundredths: 460,
    reviewsCount: 103,
    status: "dormant",
    website: "https://ssplumbing.example",
  },
  {
    name: "Bergvliet Geysers",
    city: "Bergvliet",
    ratingHundredths: 420,
    reviewsCount: 37,
    status: "candidate",
    website: "https://bergvlietgeysers.example",
  },
  {
    name: "Table Bay Drains",
    city: "Milnerton",
    ratingHundredths: 440,
    reviewsCount: 54,
    status: "disqualified",
    website: "https://tablebaydrains.example",
  },
  {
    name: "Cape Flats Plumbing",
    city: "Athlone",
    ratingHundredths: 410,
    reviewsCount: 25,
    status: "client_active",
    website: "https://capeflatsplumbing.example",
  },
];

const FIXTURE_CAMPAIGN_NAME = "Plumbers, Cape Town";
const FIXTURE_CAMPAIGN_LOCATION = "Cape Town, ZA";
const FIXTURE_CAMPAIGN_LEAD_TOTAL = 30;

/** FNV-1a, so a reference ID picks the same seed on every machine. */
function hashId(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function seedFor(id: string, offset = 0): FixtureLeadSeed {
  const index = (hashId(id) + offset) % FIXTURE_LEAD_SEEDS.length;
  return FIXTURE_LEAD_SEEDS[index] as FixtureLeadSeed;
}

function fixtureLead(
  leadId: string,
  campaignId: string,
  seed: FixtureLeadSeed,
): ResolvedDiscoveryLead {
  return {
    lead_id: leadId,
    campaign_id: campaignId,
    name: seed.name,
    status: seed.status,
    city: seed.city,
    website: seed.website,
    rating_hundredths: seed.ratingHundredths,
    reviews_count: seed.reviewsCount,
  };
}

function unavailable(ref: DiscoveryEntityRef): ResolvedDiscoveryEntity {
  return { resolved: "unavailable", kind: ref.kind, id: ref.id };
}

function resolveIndustry(ref: DiscoveryEntityRef): ResolvedDiscoveryEntity {
  const industry = FIXTURE_INDUSTRIES.find((row) => row.id === ref.id);
  if (!industry) return unavailable(ref);
  return {
    resolved: "industry",
    taxonomy: {
      industry_id: industry.id,
      industry_label: industry.name,
      description: industry.description ?? null,
      lead_count: industry.leadCount,
    },
  };
}

function resolveVertical(ref: DiscoveryEntityRef): ResolvedDiscoveryEntity {
  const [industryId, verticalId] = ref.id.split("/");
  const vertical = FIXTURE_VERTICALS.find(
    (row) => row.industryId === industryId && row.id === verticalId,
  );
  const industry = FIXTURE_INDUSTRIES.find((row) => row.id === industryId);
  if (!vertical || !industry) return unavailable(ref);
  return {
    resolved: "vertical",
    taxonomy: {
      industry_id: industry.id,
      industry_label: industry.name,
      vertical_id: vertical.id,
      vertical_label: vertical.name,
      description: vertical.description ?? null,
      lead_count: vertical.leadCount,
    },
  };
}

/** Resolve one reference against the fixture workspace. */
export function resolveFixtureDiscoveryEntity(
  ref: DiscoveryEntityRef,
): ResolvedDiscoveryEntity {
  switch (ref.kind) {
    case "industry":
      return resolveIndustry(ref);
    case "vertical":
      return resolveVertical(ref);
    case "campaign":
      return {
        resolved: "campaign",
        campaign: {
          campaign_id: ref.id,
          name: FIXTURE_CAMPAIGN_NAME,
          industry_name: "Construction",
          vertical_name: "Plumbing",
          location: FIXTURE_CAMPAIGN_LOCATION,
          lead_count: FIXTURE_CAMPAIGN_LEAD_TOTAL,
          target: FIXTURE_CAMPAIGN_LEAD_TOTAL,
        },
      };
    case "campaign_leads":
      return {
        resolved: "campaign_leads",
        collection: {
          campaign_id: ref.id,
          total: FIXTURE_CAMPAIGN_LEAD_TOTAL,
          leads: FIXTURE_LEAD_SEEDS.slice(0, 4).map((seed, index) =>
            fixtureLead(`${ref.id}-${index}`, ref.id, seed),
          ),
        },
      };
    case "lead":
      return {
        resolved: "lead",
        lead: fixtureLead(ref.id, ref.id, seedFor(ref.id)),
      };
    case "run":
      return {
        resolved: "run",
        run: {
          run_id: ref.id,
          campaign_id: ref.id,
          state: "running",
          completed_steps: 12,
          total_steps: FIXTURE_CAMPAIGN_LEAD_TOTAL,
        },
      };
    default:
      return unavailable(ref);
  }
}
