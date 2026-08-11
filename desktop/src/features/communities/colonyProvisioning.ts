/**
 * Pure shape of the connected relay's self-serve provisioning surface.
 *
 * Kept free of React and Tauri imports so the mapping below is unit-testable
 * under plain node; the hook that fetches it lives in
 * `useColonyProvisioning.ts`.
 */

/**
 * Fallback per-owner cap, matching `MAX_COMMUNITIES_PER_OWNER` in `buzz-db`.
 * Only used until the relay answers, or when it cannot be reached; operators
 * can raise the real value with `BUZZ_MAX_COMMUNITIES_PER_OWNER`.
 */
export const HOSTED_COMMUNITY_LIMIT = 3;

/** Raw `GET /api/communities/config` body. */
export type ColonyProvisioningConfig = {
  self_serve?: boolean;
  domain?: string | null;
  public?: boolean;
  max_per_owner?: number;
};

export type ColonyProvisioning = {
  /** Domain the connected relay mints hosts on, or null when it does not. */
  domain: string | null;
  /** False when this relay has no provisioning domain configured. */
  selfServe: boolean;
  /** Per-owner cap the relay enforces. */
  maxPerOwner: number;
  /** True until the relay answers; the suffix is unknown during this window. */
  loading: boolean;
  /** Set when the relay could not be reached, or is too old to answer. */
  unreachable: boolean;
};

export const PROVISIONING_PENDING: ColonyProvisioning = {
  domain: null,
  selfServe: false,
  maxPerOwner: HOSTED_COMMUNITY_LIMIT,
  loading: true,
  unreachable: false,
};

export const PROVISIONING_UNREACHABLE: ColonyProvisioning = {
  domain: null,
  selfServe: false,
  maxPerOwner: HOSTED_COMMUNITY_LIMIT,
  loading: false,
  unreachable: true,
};

/**
 * Maps a relay's config body onto what the create form needs.
 *
 * A relay that claims `self_serve` without naming a domain still cannot mint a
 * host, so both must hold: the form would otherwise offer an address the relay
 * rejects. That is the bug this whole path exists to kill — the suffix used to
 * be a client-side constant, so a local dev relay advertised the production
 * domain and every create 404'd.
 */
export function provisioningFromConfig(
  config: ColonyProvisioningConfig,
): ColonyProvisioning {
  const domain = config.domain?.trim() || null;
  return {
    domain,
    selfServe: Boolean(config.self_serve) && domain !== null,
    maxPerOwner:
      typeof config.max_per_owner === "number" && config.max_per_owner > 0
        ? config.max_per_owner
        : HOSTED_COMMUNITY_LIMIT,
    loading: false,
    unreachable: false,
  };
}
