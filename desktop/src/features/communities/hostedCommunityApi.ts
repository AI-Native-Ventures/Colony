import { invoke } from "@/shared/api/nativeBridge";

import {
  type ColonyProvisioningConfig,
  HOSTED_COMMUNITY_LIMIT,
} from "@/features/communities/colonyProvisioning";

export { HOSTED_COMMUNITY_LIMIT };

export const VALID_HOSTED_COMMUNITY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Colony self-serve provisioning ──────────────────────────────────────────
// These talk to the active relay's own /api/communities surface (NIP-98
// signed with the local identity). The relay enforces
// membership, the per-owner limit, and name rules; commands reject with a
// readable message on failure.

export type ColonyAvailability = {
  name?: string;
  normalized_host?: string;
  available?: boolean;
  reason?: string;
};

export type ColonyCreateResponse = {
  community?: HostedCommunity;
  warning?: string | null;
};

export type ColonyCommunitiesResponse = {
  owner_pubkey?: string;
  communities?: (HostedCommunity & { archived_at?: string | null })[];
};

/**
 * What the connected relay will actually provision. `domain` is null when the
 * operator never set `BUZZ_SELF_PROVISION_DOMAIN`, which is the default: that
 * relay rejects every create, so the form must say so rather than offer an
 * address it cannot mint.
 */
export function fetchColonyProvisioningConfig() {
  return invoke<ColonyProvisioningConfig>("colony_provisioning_config");
}

export function checkColonyCommunityName(name: string) {
  return invoke<ColonyAvailability>("colony_check_community_name", { name });
}

export function createColonyCommunity(name: string) {
  return invoke<ColonyCreateResponse>("colony_create_community", { name });
}

export function listColonyCommunities() {
  return invoke<ColonyCommunitiesResponse>("colony_list_my_communities");
}

export type HostedCommunityApiError = {
  code?: string;
  message?: string;
  setup_needed?: boolean;
};

export type HostedNostrIdentity = {
  npub?: string;
  pubkey_hex?: string;
};

export type HostedIdentityResponse = {
  identity?: HostedNostrIdentity;
  error?: HostedCommunityApiError;
  correlation_id?: string;
};

export type HostedCommunity = {
  id?: string;
  name?: string;
  slug?: string;
  normalized_host?: string;
  owner_pubkey?: string;
  archived_at?: string | null;
};

export type HostedCommunitiesResponse = {
  communities?: HostedCommunity[];
  error?: HostedCommunityApiError;
  correlation_id?: string;
};

export type HostedCommunityAvailabilityResponse = {
  available?: boolean;
  normalized_host?: string;
  error?: HostedCommunityApiError;
  correlation_id?: string;
};

export type HostedCommunityMutationResponse = {
  community?: HostedCommunity;
  error?: HostedCommunityApiError;
  correlation_id?: string;
};

export type HostedCommunityAccount = {
  communities: HostedCommunity[];
  identity: HostedNostrIdentity | null;
};

export function hostedCommunityErrorMessage(
  error: HostedCommunityApiError | undefined,
  correlationId: string | undefined,
  fallback: string,
) {
  const messages: Record<string, string> = {
    missing_mapping:
      "Connect your Colony identity before creating a community.",
    invalid_name: "Use lowercase letters, numbers, and hyphens.",
    taken: "That Colony address is already taken.",
    limit_reached: `You've reached the limit of ${HOSTED_COMMUNITY_LIMIT} hosted communities.`,
    relay_unavailable: "Community provisioning is temporarily unavailable.",
    not_owner: "Only the community owner can do that.",
    transferee_not_registered:
      "That person needs a connected Colony identity before you can transfer ownership to them.",
  };
  const message = messages[error?.code ?? ""] ?? error?.message ?? fallback;
  return correlationId
    ? `${message} Correlation ID: ${correlationId}`
    : message;
}

export function hostedCommunityRelayUrl(community: HostedCommunity) {
  const host = community.normalized_host?.trim();
  return host ? `wss://${host.replace(/^wss?:\/\//, "")}` : null;
}
