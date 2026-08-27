// desktop/src/features/onboarding/flow/provisionWorkspace.ts
import type {
  ColonyAvailability,
  ColonyCommunitiesResponse,
  ColonyCreateResponse,
} from "@/features/communities/hostedCommunityApi";
import { hostedCommunityRelayUrl } from "@/features/communities/hostedCommunityApi";

import { slugCandidates, slugifyCompany } from "./workspaceSlug";

export type ProvisionApi = {
  check: (name: string) => Promise<ColonyAvailability>;
  create: (name: string) => Promise<ColonyCreateResponse>;
  listMine: () => Promise<ColonyCommunitiesResponse>;
};

export type ProvisionOutcome =
  | { ok: true; slug: string; relayUrl: string; communityId: string | null }
  | {
      ok: false;
      reason: "exhausted" | "limit" | "unreachable";
      message: string;
    };

const UNREACHABLE_MESSAGE =
  "We could not reach Colony to set up your workspace. Check your internet connection and try again.";
const EXHAUSTED_MESSAGE =
  "We could not find a free address for that company name. Adjust the name slightly and try again.";
const LIMIT_MESSAGE =
  "This account already runs the maximum number of workspaces.";

/**
 * The Tauri bridge rejects with the command's Err(String) payload itself, so
 * classification reads the text out of whatever shape arrived rather than
 * trusting `instanceof Error`.
 */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "";
}

function isLimitError(error: unknown): boolean {
  return /limit_reached/i.test(errorText(error));
}

function isTakenError(error: unknown): boolean {
  return /taken/i.test(errorText(error));
}

/**
 * Claim a hosted community for the typed company name, silently absorbing
 * collisions with numbered fallbacks. `storedSlug` makes a reload-resume
 * idempotent: a community this account already owns under that slug is
 * reused instead of created twice.
 */
export async function provisionWorkspace(
  companyName: string,
  storedSlug: string | null,
  api: ProvisionApi,
): Promise<ProvisionOutcome> {
  try {
    if (storedSlug) {
      const mine = await api.listMine();
      const existing = (mine.communities ?? []).find(
        (community) => community.slug === storedSlug && !community.archived_at,
      );
      if (existing) {
        const relayUrl = hostedCommunityRelayUrl(existing);
        if (relayUrl) {
          return {
            ok: true,
            slug: storedSlug,
            relayUrl,
            communityId: existing.id ?? null,
          };
        }
      }
    }

    for (const candidate of slugCandidates(slugifyCompany(companyName))) {
      const availability = await api.check(candidate);
      if (availability.available === false) continue;
      try {
        const response = await api.create(candidate);
        const community = response.community;
        const relayUrl = community ? hostedCommunityRelayUrl(community) : null;
        if (!community || !relayUrl) {
          return {
            ok: false,
            reason: "unreachable",
            message: UNREACHABLE_MESSAGE,
          };
        }
        return {
          ok: true,
          slug: community.slug ?? candidate,
          relayUrl,
          communityId: community.id ?? null,
        };
      } catch (error) {
        if (isLimitError(error)) {
          return { ok: false, reason: "limit", message: LIMIT_MESSAGE };
        }
        if (isTakenError(error)) continue;
        throw error;
      }
    }
    return { ok: false, reason: "exhausted", message: EXHAUSTED_MESSAGE };
  } catch {
    return { ok: false, reason: "unreachable", message: UNREACHABLE_MESSAGE };
  }
}
