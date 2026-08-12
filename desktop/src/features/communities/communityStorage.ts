import type { Community } from "./types";
import { normalizeRelayUrl as normalizeRelayInput } from "./relayProbe";
import { homeDir } from "@/shared/api/nativeBridge";
import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";

const COMMUNITIES_KEY = "buzz-communities";
const ACTIVE_COMMUNITY_KEY = "buzz-active-community-id";
const LEGACY_WORKSPACES_KEY = "buzz-workspaces";
const LEGACY_ACTIVE_WORKSPACE_KEY = "buzz-active-workspace-id";
const LEGACY_AUTO_CONNECT_RECOVERY_KEY = "buzz-legacy-auto-connect-recovery.v1";
const COMMUNITY_DESTINATIONS_KEY = "buzz-community-destinations";

type LegacyAutoConnectRecovery = {
  activeCommunityId: string;
  communities: Community[];
  communityDestinations: string | null;
  version: 1;
};

/**
 * Expand a leading `~` to the user's home directory. The backend rejects
 * `~`-prefixed paths (`std::fs` does not expand the shell tilde), so the UI
 * resolves it before save. Returns non-`~` input unchanged. Empty/whitespace
 * input returns `undefined` so callers can clear the override.
 */
export async function expandTilde(input: string): Promise<string | undefined> {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "~") {
    return homeDir();
  }
  if (trimmed.startsWith("~/")) {
    const home = await homeDir();
    const base = home.endsWith("/") ? home.slice(0, -1) : home;
    return `${base}/${trimmed.slice(2)}`;
  }
  return trimmed;
}

export function migrateLegacyCommunityStorage(
  storage: Storage = localStorage,
): void {
  if (storage.getItem(COMMUNITIES_KEY) === null) {
    const legacyCommunities = storage.getItem(LEGACY_WORKSPACES_KEY);
    if (legacyCommunities !== null) {
      storage.setItem(COMMUNITIES_KEY, legacyCommunities);
    }
  }
  if (storage.getItem(ACTIVE_COMMUNITY_KEY) === null) {
    const legacyActiveCommunity = storage.getItem(LEGACY_ACTIVE_WORKSPACE_KEY);
    if (legacyActiveCommunity !== null) {
      storage.setItem(ACTIVE_COMMUNITY_KEY, legacyActiveCommunity);
    }
  }
}

export function loadCommunities(): Community[] {
  try {
    migrateLegacyCommunityStorage();
    const raw = localStorage.getItem(COMMUNITIES_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    // Migrate two pieces of legacy state in one read. Older builds could leave
    // a scheme-less relay host in localStorage; the runtime key and reqwest
    // both require an absolute URL, so repair it before the value reaches the
    // Tauri boundary. Older builds also stored the user's `nsec` here and
    // re-applied it on every reload, silently overwriting imported identities.
    // The on-disk `identity.key` file is the only source of truth now.
    let didChange = false;
    const cleaned = (parsed as Array<Record<string, unknown>>).map((entry) => {
      if (!entry || typeof entry !== "object") return entry;

      let cleanedEntry = entry;
      if (typeof entry.relayUrl === "string") {
        // Only scheme-less values need the legacy repair. The shared input
        // normalizer also canonicalizes loopback hosts, but an already-valid
        // local relay URL is a test/runtime identity and must not change from
        // localhost to 127.0.0.1 while loading persisted state.
        const normalizedRelayUrl = entry.relayUrl.includes("://")
          ? entry.relayUrl
          : normalizeRelayInput(entry.relayUrl);
        if (normalizedRelayUrl && normalizedRelayUrl !== entry.relayUrl) {
          cleanedEntry = { ...cleanedEntry, relayUrl: normalizedRelayUrl };
          didChange = true;
        }
      }

      if ("nsec" in cleanedEntry) {
        const { nsec: _nsec, ...rest } = cleanedEntry;
        cleanedEntry = rest;
        didChange = true;
      }

      return cleanedEntry;
    }) as Community[];
    if (didChange) {
      setLocalStorageItemWithRecovery(COMMUNITIES_KEY, JSON.stringify(cleaned));
    }
    return cleaned;
  } catch {
    return [];
  }
}

export function saveCommunities(communities: Community[]): boolean {
  return setLocalStorageItemWithRecovery(
    COMMUNITIES_KEY,
    JSON.stringify(communities),
  );
}

export function clearCommunityStorage(storage: Storage = localStorage): void {
  storage.removeItem(COMMUNITIES_KEY);
  storage.removeItem(ACTIVE_COMMUNITY_KEY);
  storage.removeItem(LEGACY_WORKSPACES_KEY);
  storage.removeItem(LEGACY_ACTIVE_WORKSPACE_KEY);
}

export function loadActiveCommunityId(): string | null {
  migrateLegacyCommunityStorage();
  return localStorage.getItem(ACTIVE_COMMUNITY_KEY);
}

export function saveActiveCommunityId(id: string): boolean {
  return setLocalStorageItemWithRecovery(ACTIVE_COMMUNITY_KEY, id);
}

export function normalizeRelayUrl(url: string): string {
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    return `wss://${url}`;
  }
  return url;
}

function isLocalRelayHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(hostname);
}

export function shouldAutoConnectDefaultRelay(relayUrl: string): boolean {
  try {
    const parsed = new URL(relayUrl);
    return (
      (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
      !isLocalRelayHost(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function deriveCommunityName(relayUrl: string): string {
  try {
    const url = new URL(
      relayUrl.replace("ws://", "http://").replace("wss://", "https://"),
    );
    const host = url.hostname;
    if (isLocalRelayHost(host)) {
      return "Local Dev";
    }
    const parts = host.split(".");
    // Detect staging environments (e.g. buzz-oss.stage.blox.sqprod.co)
    if (parts.some((p) => p === "stage" || p === "staging")) {
      return "Colony (staging)";
    }
    // Use the first subdomain segment or the domain itself
    if (parts.length >= 2) {
      return parts[0] === "relay" ? parts[1] : parts[0];
    }
    return host;
  } catch {
    return "Community";
  }
}

function canonicalRelayUrl(relayUrl: string): string | null {
  try {
    const parsed = new URL(normalizeRelayUrl(relayUrl));
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return null;
    }
    if (parsed.pathname === "/") {
      parsed.pathname = "";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Identify the exact community record written by the obsolete public-build
 * default-relay auto-connect path. Callers must additionally have a confirmed
 * membership denial before clearing the record.
 */
export function shouldRecoverLegacyAutoConnectedCommunity({
  activePubkey,
  activeCommunityId,
  autoConnectDefaultRelay,
  communities,
  defaultRelayUrl,
}: {
  activePubkey: string;
  activeCommunityId: string | null;
  autoConnectDefaultRelay: boolean;
  communities: Community[];
  defaultRelayUrl: string;
}): boolean {
  if (autoConnectDefaultRelay || communities.length !== 1) {
    return false;
  }

  const [community] = communities;
  const canonicalDefaultRelayUrl = canonicalRelayUrl(defaultRelayUrl);
  return (
    community.id === activeCommunityId &&
    community.pubkey === activePubkey &&
    canonicalDefaultRelayUrl !== null &&
    canonicalRelayUrl(community.relayUrl) === canonicalDefaultRelayUrl &&
    community.name === deriveCommunityName(defaultRelayUrl) &&
    !community.token?.trim() &&
    !community.reposDir?.trim()
  );
}

/**
 * Preserve a restorable snapshot before clearing the obsolete community.
 * Existing snapshots are never overwritten; recovery fails closed instead.
 */
export function quarantineLegacyAutoConnectedCommunity({
  activePubkey,
  autoConnectDefaultRelay,
  defaultRelayUrl,
}: {
  activePubkey: string;
  autoConnectDefaultRelay: boolean;
  defaultRelayUrl: string;
}): boolean {
  const communities = loadCommunities();
  const activeCommunityId = loadActiveCommunityId();
  if (
    activeCommunityId === null ||
    !shouldRecoverLegacyAutoConnectedCommunity({
      activePubkey,
      activeCommunityId,
      autoConnectDefaultRelay,
      communities,
      defaultRelayUrl,
    })
  ) {
    return false;
  }
  const existingRecovery = loadLegacyAutoConnectRecovery();
  if (localStorage.getItem(LEGACY_AUTO_CONNECT_RECOVERY_KEY) !== null) {
    const currentDestinations = localStorage.getItem(
      COMMUNITY_DESTINATIONS_KEY,
    );
    if (
      !existingRecovery ||
      existingRecovery.activeCommunityId !== activeCommunityId ||
      JSON.stringify(existingRecovery.communities) !==
        JSON.stringify(communities) ||
      existingRecovery.communityDestinations !== currentDestinations
    ) {
      return false;
    }

    clearCommunityStorage();
    return true;
  }

  const didSave = setLocalStorageItemWithRecovery(
    LEGACY_AUTO_CONNECT_RECOVERY_KEY,
    JSON.stringify({
      activeCommunityId,
      communities,
      communityDestinations: localStorage.getItem(COMMUNITY_DESTINATIONS_KEY),
      version: 1,
    } satisfies LegacyAutoConnectRecovery),
  );
  if (!didSave) {
    return false;
  }

  clearCommunityStorage();
  return true;
}

function loadLegacyAutoConnectRecovery(): LegacyAutoConnectRecovery | null {
  try {
    const raw = localStorage.getItem(LEGACY_AUTO_CONNECT_RECOVERY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<LegacyAutoConnectRecovery>;
    return candidate.version === 1 &&
      typeof candidate.activeCommunityId === "string" &&
      Array.isArray(candidate.communities) &&
      (candidate.communityDestinations === null ||
        typeof candidate.communityDestinations === "string")
      ? (candidate as LegacyAutoConnectRecovery)
      : null;
  } catch {
    return null;
  }
}

function recoveryMatchesIdentity(
  recovery: LegacyAutoConnectRecovery,
  activePubkey: string,
): boolean {
  if (recovery.communities.length !== 1) return false;
  const [community] = recovery.communities;
  return (
    community.id === recovery.activeCommunityId &&
    community.pubkey === activePubkey
  );
}

export function hasLegacyAutoConnectRecovery(
  activePubkey: string | undefined,
): boolean {
  const recovery = loadLegacyAutoConnectRecovery();
  return Boolean(
    recovery && activePubkey && recoveryMatchesIdentity(recovery, activePubkey),
  );
}

/**
 * Restore the quarantined community for the same identity. Writes the active
 * ID and destinations before communities so an interrupted restore remains on
 * setup, where the same operation can safely resume.
 */
export function restoreLegacyAutoConnectedCommunity(
  activePubkey: string,
): boolean {
  const recovery = loadLegacyAutoConnectRecovery();
  if (!recovery || !recoveryMatchesIdentity(recovery, activePubkey)) {
    return false;
  }

  const expectedCommunities = JSON.stringify(recovery.communities);
  const liveCommunities = localStorage.getItem(COMMUNITIES_KEY);
  const liveActiveCommunityId = localStorage.getItem(ACTIVE_COMMUNITY_KEY);
  const liveDestinations = localStorage.getItem(COMMUNITY_DESTINATIONS_KEY);
  if (
    (liveCommunities !== null && liveCommunities !== expectedCommunities) ||
    (liveActiveCommunityId !== null &&
      liveActiveCommunityId !== recovery.activeCommunityId) ||
    (recovery.communityDestinations === null
      ? liveDestinations !== null
      : liveDestinations !== null &&
        liveDestinations !== recovery.communityDestinations)
  ) {
    return false;
  }

  if (
    recovery.communityDestinations !== null &&
    liveDestinations === null &&
    !setLocalStorageItemWithRecovery(
      COMMUNITY_DESTINATIONS_KEY,
      recovery.communityDestinations,
    )
  ) {
    return false;
  }
  if (
    liveActiveCommunityId === null &&
    !saveActiveCommunityId(recovery.activeCommunityId)
  ) {
    return false;
  }
  if (liveCommunities === null && !saveCommunities(recovery.communities)) {
    return false;
  }

  localStorage.removeItem(LEGACY_AUTO_CONNECT_RECOVERY_KEY);
  return true;
}

export function initFirstCommunity(
  relayUrl: string,
  pubkey: string,
  name?: string,
): Community | null {
  const normalizedUrl = normalizeRelayUrl(relayUrl);
  const trimmedName = name?.trim();
  const community: Community = {
    id: crypto.randomUUID(),
    name: trimmedName || deriveCommunityName(normalizedUrl),
    relayUrl: normalizedUrl,
    // Compiled default relays must admit the first token-less connection; there
    // is no invite-token prompt on this auto-connect path.
    pubkey,
    addedAt: new Date().toISOString(),
  };
  const previousActiveCommunityId = localStorage.getItem(ACTIVE_COMMUNITY_KEY);
  const didSaveActiveCommunity = saveActiveCommunityId(community.id);
  if (!didSaveActiveCommunity) {
    return null;
  }

  if (!saveCommunities([community])) {
    // A failed setItem leaves the existing communities value untouched. Roll
    // back only the active-ID write so inconsistent pre-existing data is never
    // destroyed while recovering from a quota failure.
    try {
      if (previousActiveCommunityId === null) {
        localStorage.removeItem(ACTIVE_COMMUNITY_KEY);
      } else {
        localStorage.setItem(ACTIVE_COMMUNITY_KEY, previousActiveCommunityId);
      }
    } catch {
      // Best effort: persistence is already unavailable, and callers will stay
      // on setup instead of reloading.
    }
    return null;
  }

  return community;
}
