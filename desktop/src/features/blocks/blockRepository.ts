import { verifyEvent } from "nostr-tools/pure";

import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import { relayMembersFromEvent } from "@/shared/api/relayMembers";
import { getUsersBatch } from "@/shared/api/tauriProfiles";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_BLOCK_CATALOG_ENTRY,
  KIND_BLOCK_MANIFEST,
} from "@/shared/constants/kinds";

import type {
  BlockFailureCode,
  BlockManifest,
  BlockManifestRecord,
  BlockParseResult,
  BlockTrust,
  BlockWorkspaceTrust,
} from "./contracts";
import {
  blockJsonSha256,
  canonicalBlockJson,
  validateBlockManifest,
} from "./blockValidation";

const MAX_MANIFESTS_PER_COMMUNITY = 200;
const KIND_NIP43_MEMBERSHIP_LIST = 13534;
const EVENT_ID_RE = /^[0-9a-f]{64}$/;

/**
 * SHA-256 of the canonical JSON for each manifest embedded by the relay.
 * Relay authorship alone never grants Core trust: both the active relay key and
 * one of these reviewed product digests must match.
 */
export const BUNDLED_CORE_MANIFEST_DIGESTS: ReadonlySet<string> = new Set([
  "d9a3804173fb77c5c3a084889b528519188f48a5520bc3fcea3a39fffb3c78fb",
  "613baba8284b6e0a474b621de8d3444d62cafc709ab9b7c4d41b1f0e7025ef8f",
  "0cc52eb39da3700731b60de102b42cb0efdefc38327f4dc562346a8d4918ff5d",
  "4672923e3d54245a44b2d9722a0e89e1bd109268cb425c4a861a50605bcb5b52",
  "78cd3ac006f93b01c521c726b3dd5de070452d99045e877060b0722f9f4b2da3",
  "8ca4e9fe46e49cbad93dbfd3b375790995432898273810568275f6166a8fc7ac",
  "af36e6867922c4fafd00ed6280a56d720fb1ab6f312fb6d4be0c72ca953f5fa5",
  "a619ca960e77e1aade371bb5e10dcff8d22105abfc778f6237ecb635517bf7c2",
  "ca17325975b2d7d37a5ed5786728d3e7992e0dce02bb5f9962ff655255a4af0b",
  "7230932d4988e12b766fef18dfd833e39bc38d480bca4aefef15e41b5b258680",
  "985799c0b35ea2660326c7021750324eba9f04a5b2bf0912549b8976c960e0ca",
  "68e8009a3268889b45ee16b4c166b906934a06b924420360c5134294e1d3592c",
  "ac4ac00924546181a4771c652340a9c861f36e99a3a62803ffacf8fdb84d51b8",
  "3f90a6f201e52fa35b9ebb7e5fd75d394e398d1cd391a7c8f77d37b9704cfb40",
  "d7c03f0a0f3d4b603394cfcf388efeebfb1b6bcae080f24fb9291ddc19e3c885",
  "1b304e8462becddfb008209bcca017c8618e872a5b2d82b1b6ddf86c4faec3a3",
  "629d6ca7eaa203506e163ea82ae09527c32f1c585b9a750d3b45fa96d342fc89",
  "831124bc552ece44081713a5d2cf74806ebe28f1315fabc76137e1c6e8db88bd",
  // company-blueprint
  "da2b06b956d238ca21425665b3f2ef98681bb4fc108c5ec4aa5d75af3f27ec45",
  // interview
  "44f7517a011316af12f5057128851b885e23842fb14cedbcd4a75578c76e7ff7",
  // company-brief
  "6936a3f3b147ad3739dc19fae71df77fb2010de6953fb4039e6d7f06e359b2a5",
  // initiative
  "1e350094a920530ccaf8ee6d521ab0dc8bf2a3103b6a0200ab578aba77d36967",
  // handover
  "f31222338ccf185b21e4ac189bf2e61f779146b8703bd01748d3359f8e380a6b",
]);

type CachedManifest = {
  event: RelayEvent;
  manifest: BlockManifest;
  digest: string;
};

export type BlockRepositoryDependencies = {
  fetchManifest: (eventId: string) => Promise<RelayEvent | null>;
  fetchActiveCatalog: (
    handle: string,
    relaySelfPubkey: string,
  ) => Promise<RelayEvent | null>;
  relaySelf: () => Promise<string | null>;
  workspaceTrust: (
    publisherPubkey: string,
    relaySelfPubkey: string | null,
  ) => Promise<BlockWorkspaceTrust>;
};

export type BlockManifestRequest = {
  communityId: string;
  manifestId: string;
  configuredPublisherPubkeys?: ReadonlySet<string>;
  workspaceTrust?: BlockWorkspaceTrust;
  relaySelfPubkey?: string | null;
};

const cacheByCommunity = new Map<string, Map<string, CachedManifest>>();
const inflightByCommunity = new Map<
  string,
  Map<string, Promise<BlockParseResult<CachedManifest>>>
>();
let repositoryGeneration = 0;

function failure<T>(
  code: BlockFailureCode,
  message: string,
): BlockParseResult<T> {
  return { ok: false, code, message };
}

function normalizeHex(value: string): string {
  return value.trim().toLowerCase();
}

function validSignedEvent(event: RelayEvent): boolean {
  try {
    // nostr-tools memoizes verification on event objects. Relay events cross
    // IPC as plain JSON, but cloning here also prevents a caller-supplied
    // memoization symbol from surviving into this security boundary.
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    });
  } catch {
    return false;
  }
}

function manifestTagMatches(
  event: RelayEvent,
  manifest: BlockManifest,
): boolean {
  const tags = event.tags.filter((tag) => tag[0] === "block");
  return (
    tags.length === 1 &&
    tags[0]?.length === 4 &&
    tags[0]?.[1] === "1" &&
    tags[0]?.[2] === manifest.handle &&
    tags[0]?.[3] === manifest.version
  );
}

function readCache(
  communityId: string,
  manifestId: string,
): CachedManifest | null {
  const communityCache = cacheByCommunity.get(communityId);
  const cached = communityCache?.get(manifestId) ?? null;
  if (cached && communityCache) {
    communityCache.delete(manifestId);
    communityCache.set(manifestId, cached);
  }
  return cached;
}

function writeCache(
  communityId: string,
  manifestId: string,
  manifest: CachedManifest,
): void {
  let communityCache = cacheByCommunity.get(communityId);
  if (!communityCache) {
    communityCache = new Map();
    cacheByCommunity.set(communityId, communityCache);
  }
  communityCache.delete(manifestId);
  communityCache.set(manifestId, manifest);
  while (communityCache.size > MAX_MANIFESTS_PER_COMMUNITY) {
    const oldest = communityCache.keys().next().value;
    if (oldest === undefined) break;
    communityCache.delete(oldest);
  }
}

async function fetchAndValidateManifest(
  dependencies: BlockRepositoryDependencies,
  manifestId: string,
): Promise<BlockParseResult<CachedManifest>> {
  try {
    const event = await dependencies.fetchManifest(manifestId);
    if (!event) {
      return failure("missing-manifest", "Block manifest was not found");
    }
    if (
      event.kind !== KIND_BLOCK_MANIFEST ||
      normalizeHex(event.id) !== manifestId ||
      !validSignedEvent(event)
    ) {
      return failure(
        "invalid-event",
        "Block manifest event ID or signature is invalid",
      );
    }
    let content: unknown;
    try {
      content = JSON.parse(event.content);
    } catch {
      return failure("invalid-json", "Block manifest content is not JSON");
    }
    if (canonicalBlockJson(content) !== event.content) {
      return failure(
        "invalid-manifest",
        "Block manifest content must use canonical JSON",
      );
    }
    const validated = validateBlockManifest(content);
    if (!validated.ok) return validated;
    if (!manifestTagMatches(event, validated.value)) {
      return failure(
        "invalid-manifest",
        "Block manifest tag handle/version does not match its content",
      );
    }
    return {
      ok: true,
      value: {
        event,
        manifest: validated.value,
        digest: blockJsonSha256(content),
      },
    };
  } catch (error) {
    return failure(
      "unavailable",
      `Block manifest could not be loaded: ${String(error)}`,
    );
  }
}

async function getCachedManifest(
  dependencies: BlockRepositoryDependencies,
  communityId: string,
  manifestId: string,
): Promise<BlockParseResult<CachedManifest>> {
  const cached = readCache(communityId, manifestId);
  if (cached) return { ok: true, value: cached };

  let communityInflight = inflightByCommunity.get(communityId);
  if (!communityInflight) {
    communityInflight = new Map();
    inflightByCommunity.set(communityId, communityInflight);
  }
  const existing = communityInflight.get(manifestId);
  if (existing) return existing;

  const generation = repositoryGeneration;
  const request: Promise<BlockParseResult<CachedManifest>> = (async () => {
    try {
      const result = await fetchAndValidateManifest(dependencies, manifestId);
      if (result.ok && generation === repositoryGeneration) {
        writeCache(communityId, manifestId, result.value);
      }
      return result;
    } catch (error) {
      return failure<CachedManifest>(
        "unavailable",
        `Block manifest could not be loaded: ${String(error)}`,
      );
    } finally {
      communityInflight?.delete(manifestId);
    }
  })();
  communityInflight.set(manifestId, request);
  return request;
}

function isOwnerOrAdmin(
  roles: BlockWorkspaceTrust["memberRoles"],
  pubkey: string | undefined,
): boolean {
  if (!pubkey) return false;
  const role = roles.get(normalizeHex(pubkey));
  return role === "owner" || role === "admin";
}

function exactActiveCatalogTarget(
  event: RelayEvent | null,
  relaySelfPubkey: string,
  manifest: CachedManifest,
): boolean {
  if (
    !event ||
    event.kind !== KIND_BLOCK_CATALOG_ENTRY ||
    normalizeHex(event.pubkey) !== relaySelfPubkey ||
    !validSignedEvent(event)
  ) {
    return false;
  }
  const dTags = event.tags.filter((tag) => tag[0] === "d");
  const targetTags = event.tags.filter(
    (tag) => tag[0] === "e" && tag[3] === "block-manifest",
  );
  const stateTags = event.tags.filter((tag) => tag[0] === "block-state");
  if (
    dTags.length !== 1 ||
    dTags[0]?.length !== 2 ||
    dTags[0]?.[1] !== manifest.manifest.handle ||
    targetTags.length !== 1 ||
    targetTags[0]?.length !== 4 ||
    normalizeHex(targetTags[0]?.[1] ?? "") !==
      normalizeHex(manifest.event.id) ||
    stateTags.length !== 1 ||
    stateTags[0]?.length !== 2 ||
    stateTags[0]?.[1] !== "active"
  ) {
    return false;
  }
  try {
    const content = JSON.parse(event.content) as {
      handle?: unknown;
      active_manifest_id?: unknown;
      status?: unknown;
      origin?: unknown;
    };
    return (
      canonicalBlockJson(content) === event.content &&
      content.handle === manifest.manifest.handle &&
      content.active_manifest_id === manifest.event.id &&
      content.status === "active" &&
      content.origin === manifest.manifest.origin
    );
  } catch {
    return false;
  }
}

async function classifyTrust(
  dependencies: BlockRepositoryDependencies,
  cached: CachedManifest,
  request: BlockManifestRequest,
): Promise<BlockTrust> {
  const relaySelfPubkey = normalizeHex(
    request.relaySelfPubkey === undefined
      ? ((await dependencies.relaySelf()) ?? "")
      : (request.relaySelfPubkey ?? ""),
  );
  const authorPubkey = normalizeHex(cached.event.pubkey);

  if (
    relaySelfPubkey !== "" &&
    authorPubkey === relaySelfPubkey &&
    cached.manifest.origin === "core" &&
    BUNDLED_CORE_MANIFEST_DIGESTS.has(cached.digest)
  ) {
    return "core";
  }

  const workspaceTrust =
    request.workspaceTrust ??
    (await dependencies.workspaceTrust(authorPubkey, relaySelfPubkey || null));
  if (
    isOwnerOrAdmin(workspaceTrust.memberRoles, authorPubkey) ||
    isOwnerOrAdmin(
      workspaceTrust.memberRoles,
      workspaceTrust.verifiedAgentOwners.get(authorPubkey),
    )
  ) {
    return "workspace-custom";
  }

  const configuredPublishers =
    request.configuredPublisherPubkeys ??
    workspaceTrust.installedPublisherPubkeys;
  if (
    [...configuredPublishers].some(
      (publisher) => normalizeHex(publisher) === authorPubkey,
    )
  ) {
    return "installed";
  }

  if (
    relaySelfPubkey !== "" &&
    (cached.manifest.origin === "workspace-custom" ||
      cached.manifest.origin === "installed")
  ) {
    const activeCatalog = await dependencies.fetchActiveCatalog(
      cached.manifest.handle,
      relaySelfPubkey,
    );
    if (exactActiveCatalogTarget(activeCatalog, relaySelfPubkey, cached)) {
      return cached.manifest.origin;
    }
  }
  return "untrusted";
}

export function createBlockRepository(
  dependencies: BlockRepositoryDependencies,
) {
  return {
    async load(
      request: BlockManifestRequest,
    ): Promise<BlockParseResult<BlockManifestRecord>> {
      const manifestId = normalizeHex(request.manifestId);
      if (request.communityId.trim() === "" || !EVENT_ID_RE.test(manifestId)) {
        return failure(
          "invalid-event",
          "community and manifest event ID are required",
        );
      }
      const cached = await getCachedManifest(
        dependencies,
        request.communityId,
        manifestId,
      );
      if (!cached.ok) return cached;
      try {
        const trust = await classifyTrust(dependencies, cached.value, request);
        return {
          ok: true,
          value: {
            ...cached.value,
            trust,
          },
        };
      } catch (error) {
        return failure(
          "unavailable",
          `Block trust could not be established: ${String(error)}`,
        );
      }
    },
  };
}

async function defaultWorkspaceTrust(
  publisherPubkey: string,
  relaySelfPubkey: string | null,
): Promise<BlockWorkspaceTrust> {
  const memberRoles = new Map<string, "owner" | "admin" | "member">();
  if (relaySelfPubkey) {
    const snapshot = await relayClient.fetchFirstEvent({
      kinds: [KIND_NIP43_MEMBERSHIP_LIST],
      authors: [relaySelfPubkey],
      limit: 1,
    });
    if (
      snapshot &&
      normalizeHex(snapshot.pubkey) === relaySelfPubkey &&
      validSignedEvent(snapshot)
    ) {
      for (const member of relayMembersFromEvent(snapshot)) {
        memberRoles.set(normalizeHex(member.pubkey), member.role);
      }
    }
  }

  const verifiedAgentOwners = new Map<string, string>();
  const profiles = await getUsersBatch([publisherPubkey]);
  const profile =
    profiles.profiles[publisherPubkey] ??
    profiles.profiles[normalizeHex(publisherPubkey)];
  if (profile?.isAgent && profile.ownerPubkey) {
    verifiedAgentOwners.set(
      normalizeHex(publisherPubkey),
      normalizeHex(profile.ownerPubkey),
    );
  }
  return {
    memberRoles,
    verifiedAgentOwners,
    installedPublisherPubkeys: new Set(),
  };
}

const defaultRepository = createBlockRepository({
  async fetchManifest(eventId) {
    return relayClient.fetchFirstEvent({
      ids: [eventId],
      kinds: [KIND_BLOCK_MANIFEST],
      limit: 1,
    });
  },
  async fetchActiveCatalog(handle, relaySelfPubkey) {
    return relayClient.fetchFirstEvent({
      kinds: [KIND_BLOCK_CATALOG_ENTRY],
      authors: [relaySelfPubkey],
      "#d": [handle],
      limit: 1,
    });
  },
  relaySelf: getRelaySelf,
  workspaceTrust: defaultWorkspaceTrust,
});

export function loadBlockManifest(
  request: BlockManifestRequest,
): Promise<BlockParseResult<BlockManifestRecord>> {
  return defaultRepository.load(request);
}

export function resetBlockRepository(): void {
  repositoryGeneration += 1;
  cacheByCommunity.clear();
  inflightByCommunity.clear();
}
