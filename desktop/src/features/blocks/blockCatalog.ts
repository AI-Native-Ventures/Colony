import { useQuery } from "@tanstack/react-query";
import { verifyEvent } from "nostr-tools/pure";

import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_BLOCK_CATALOG_ENTRY,
  KIND_STREAM_MESSAGE,
} from "@/shared/constants/kinds";

import { parseBlockInstance } from "./blockTags";
import type {
  BlockManifestRecord,
  BlockOrigin,
  BlockParseResult,
  BlockPermission,
} from "./contracts";
import { loadBlockManifest } from "./blockRepository";
import { canonicalBlockJson, normalizeBlockHandle } from "./blockValidation";

const EVENT_ID_RE = /^[0-9a-f]{64}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATALOG_SCHEMAS = new Set([
  "ai-native-office/block-catalog-entry/v1",
  "https://ai-native-office.dev/schemas/block-catalog-entry/v1",
]);
const CATALOG_CONTENT_KEYS = new Set([
  "active_manifest_id",
  "handle",
  "origin",
  "permissions",
  "preview",
  "schema",
  "status",
  "summary",
  "workshop",
]);
const RECENT_USAGE_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const RELAY_FILTER_TAG_LIMIT = 50;

export type BlockCatalogStatus = "active" | "deprecated";

export type BlockCatalogEntry = {
  activeManifestId: string;
  catalogEventId: string;
  handle: string;
  origin: BlockOrigin;
  permissions: BlockPermission[];
  preview: unknown;
  publisherPubkey: string;
  schema: string;
  status: BlockCatalogStatus;
  summary: string;
  workshop: string | null;
};

export type BlockCatalogItem = {
  blockAddress: string;
  catalogEventId: string;
  handle: string;
  manifestId: string;
  manifestRecord: BlockManifestRecord;
  name: string;
  origin: BlockOrigin;
  permissions: BlockPermission[];
  preview: unknown;
  publisherPubkey: string;
  recentUsage: {
    complete: boolean;
    count: number | null;
    lastUsedAt: number | null;
  };
  status: BlockCatalogStatus;
  summary: string;
  workshop: string | null;
};

export type BlockWorkshopDestination = {
  channelId: string;
  messageId?: string;
  threadRootId?: string;
};

export type BlockCatalogHandoff =
  | ({ kind: "workshop" } & BlockWorkshopDestination)
  | {
      kind: "new-message";
      blockAddress: string;
      blockHandle: string;
      blockManifestId: string;
    };

type BlockCatalogDependencies = {
  fetchCatalogEvents: (relaySelfPubkey: string) => Promise<RelayEvent[]>;
  fetchRecentMessages: (
    channelIds: readonly string[],
  ) => Promise<{ complete: boolean; events: RelayEvent[] }>;
  loadManifest: (
    communityId: string,
    manifestId: string,
    relaySelfPubkey: string,
  ) => Promise<BlockParseResult<BlockManifestRecord>>;
  relaySelf: () => Promise<string | null>;
};

function validSignedEvent(event: RelayEvent): boolean {
  try {
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

function exactTag(event: RelayEvent, name: string): string[] | null {
  const tags = event.tags.filter((tag) => tag[0] === name);
  return tags.length === 1 ? (tags[0] ?? null) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePermissions(value: unknown): BlockPermission[] | null {
  if (!Array.isArray(value)) return null;
  const permissions: BlockPermission[] = [];
  for (const permission of value) {
    if (
      !isRecord(permission) ||
      Object.keys(permission).some(
        (key) => key !== "capability" && key !== "constraints",
      ) ||
      typeof permission.capability !== "string" ||
      permission.capability.trim() === "" ||
      !Object.hasOwn(permission, "constraints")
    ) {
      return null;
    }
    permissions.push({
      capability: permission.capability,
      constraints: permission.constraints,
    });
  }
  return permissions;
}

/**
 * Validate one relay-authored catalog head before it is projected into UI.
 * The signature, replaceable-event tags, and canonical body must all agree.
 */
export function parseBlockCatalogEntry(
  event: RelayEvent,
  relaySelfPubkey: string,
): BlockCatalogEntry | null {
  const normalizedRelaySelf = relaySelfPubkey.trim().toLowerCase();
  if (
    !PUBKEY_RE.test(normalizedRelaySelf) ||
    event.kind !== KIND_BLOCK_CATALOG_ENTRY ||
    event.pubkey.toLowerCase() !== normalizedRelaySelf ||
    event.tags.some((tag) => tag[0] === "h") ||
    !validSignedEvent(event)
  ) {
    return null;
  }

  const dTag = exactTag(event, "d");
  const manifestTag = exactTag(event, "e");
  const stateTag = exactTag(event, "block-state");
  if (
    dTag?.length !== 2 ||
    manifestTag?.length !== 4 ||
    manifestTag[2] !== "" ||
    manifestTag[3] !== "block-manifest" ||
    stateTag?.length !== 2 ||
    !EVENT_ID_RE.test(manifestTag[1] ?? "") ||
    !["active", "deprecated"].includes(stateTag[1] ?? "")
  ) {
    return null;
  }
  const normalizedHandle = normalizeBlockHandle(dTag[1] ?? "");
  if (!normalizedHandle.ok || normalizedHandle.value !== dTag[1]) {
    return null;
  }

  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (
    !isRecord(content) ||
    canonicalBlockJson(content) !== event.content ||
    Object.keys(content).some((key) => !CATALOG_CONTENT_KEYS.has(key)) ||
    typeof content.schema !== "string" ||
    !CATALOG_SCHEMAS.has(content.schema) ||
    content.handle !== dTag[1] ||
    content.active_manifest_id !== manifestTag[1] ||
    content.status !== stateTag[1] ||
    !["core", "installed", "workspace-custom"].includes(
      String(content.origin),
    ) ||
    typeof content.summary !== "string" ||
    content.summary.trim() === "" ||
    !Object.hasOwn(content, "preview") ||
    (content.workshop !== undefined &&
      (typeof content.workshop !== "string" || content.workshop.trim() === ""))
  ) {
    return null;
  }
  const permissions = parsePermissions(content.permissions);
  if (!permissions) return null;

  return {
    activeManifestId: manifestTag[1],
    catalogEventId: event.id,
    handle: dTag[1],
    origin: content.origin as BlockOrigin,
    permissions,
    preview: content.preview,
    publisherPubkey: event.pubkey,
    schema: content.schema,
    status: stateTag[1] as BlockCatalogStatus,
    summary: content.summary,
    workshop:
      typeof content.workshop === "string" ? content.workshop.trim() : null,
  };
}

function preferCatalogEvent(candidate: RelayEvent, current: RelayEvent) {
  if (candidate.created_at !== current.created_at) {
    return candidate.created_at > current.created_at;
  }
  // NIP-01 uses the lowest event ID as the deterministic tie-breaker for
  // replaceable events with identical timestamps.
  return candidate.id.localeCompare(current.id) < 0;
}

function catalogHeads(
  events: readonly RelayEvent[],
  relaySelfPubkey: string,
): BlockCatalogEntry[] {
  const byHandle = new Map<
    string,
    { entry: BlockCatalogEntry; event: RelayEvent }
  >();
  for (const event of events) {
    const entry = parseBlockCatalogEntry(event, relaySelfPubkey);
    if (!entry) continue;
    const current = byHandle.get(entry.handle);
    if (!current || preferCatalogEvent(event, current.event)) {
      byHandle.set(entry.handle, { entry, event });
    }
  }
  return [...byHandle.values()].map(({ entry }) => entry);
}

export function summarizeRecentBlockUsage(
  events: readonly RelayEvent[],
  allowedChannelIds: readonly string[],
): Map<string, { count: number; lastUsedAt: number | null }> {
  const allowedChannels = new Set(allowedChannelIds);
  const usage = new Map<string, { count: number; lastUsedAt: number | null }>();
  for (const event of events) {
    const channelTag = exactTag(event, "h");
    if (
      event.kind !== KIND_STREAM_MESSAGE ||
      !validSignedEvent(event) ||
      channelTag?.length !== 2 ||
      !allowedChannels.has(channelTag[1] ?? "")
    ) {
      continue;
    }
    const instance = parseBlockInstance(event.tags);
    if (!instance.ok) continue;
    const current = usage.get(instance.value.handle) ?? {
      count: 0,
      lastUsedAt: null,
    };
    usage.set(instance.value.handle, {
      count: current.count + 1,
      lastUsedAt: Math.max(current.lastUsedAt ?? 0, event.created_at),
    });
  }
  return usage;
}

export function blockCatalogAddress(
  relaySelfPubkey: string,
  handle: string,
): string | null {
  const normalizedRelaySelf = relaySelfPubkey.trim().toLowerCase();
  const normalizedHandle = normalizeBlockHandle(handle);
  if (
    !PUBKEY_RE.test(normalizedRelaySelf) ||
    !normalizedHandle.ok ||
    normalizedHandle.value !== handle
  ) {
    return null;
  }
  return `${KIND_BLOCK_CATALOG_ENTRY}:${normalizedRelaySelf}:${handle}`;
}

export function parseBlockWorkshopDestination(
  workshop: string | null | undefined,
): BlockWorkshopDestination | null {
  const value = workshop?.trim();
  if (!value) return null;
  if (UUID_RE.test(value)) {
    return { channelId: value };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "buzz:" || url.hostname !== "message") return null;

  const channelId = url.searchParams.get("channel") ?? "";
  const messageId = url.searchParams.get("id") ?? "";
  const threadRootId = url.searchParams.get("thread") ?? "";
  if (
    !UUID_RE.test(channelId) ||
    (messageId !== "" && !EVENT_ID_RE.test(messageId)) ||
    (threadRootId !== "" && !EVENT_ID_RE.test(threadRootId)) ||
    (threadRootId !== "" && messageId === "")
  ) {
    return null;
  }
  return {
    channelId,
    ...(messageId ? { messageId } : {}),
    ...(threadRootId ? { threadRootId } : {}),
  };
}

export function resolveBlockCatalogHandoff(
  item: Pick<
    BlockCatalogItem,
    "blockAddress" | "handle" | "manifestId" | "workshop"
  >,
): BlockCatalogHandoff {
  const workshop = parseBlockWorkshopDestination(item.workshop);
  return workshop
    ? { kind: "workshop", ...workshop }
    : {
        kind: "new-message",
        blockAddress: item.blockAddress,
        blockHandle: item.handle,
        blockManifestId: item.manifestId,
      };
}

export async function loadBlockCatalog(
  request: {
    channelIds: readonly string[];
    communityId: string;
    recentUsageAvailable?: boolean;
  },
  dependencies: BlockCatalogDependencies = defaultDependencies,
): Promise<BlockCatalogItem[]> {
  const relaySelfPubkey = (await dependencies.relaySelf())?.toLowerCase() ?? "";
  if (!PUBKEY_RE.test(relaySelfPubkey)) {
    throw new Error("The relay does not advertise a valid signing identity.");
  }

  const catalogEvents = await dependencies.fetchCatalogEvents(relaySelfPubkey);
  const heads = catalogHeads(catalogEvents, relaySelfPubkey);
  const recentUsageAvailable = request.recentUsageAvailable ?? true;
  const [manifestResults, recentMessages] = await Promise.all([
    Promise.all(
      heads.map((entry) =>
        dependencies.loadManifest(
          request.communityId,
          entry.activeManifestId,
          relaySelfPubkey,
        ),
      ),
    ),
    recentUsageAvailable && request.channelIds.length > 0
      ? dependencies.fetchRecentMessages(request.channelIds)
      : Promise.resolve({
          complete: recentUsageAvailable,
          events: [] as RelayEvent[],
        }),
  ]);
  const recentUsage = summarizeRecentBlockUsage(
    recentMessages.events,
    request.channelIds,
  );
  const items: BlockCatalogItem[] = [];

  for (const [index, entry] of heads.entries()) {
    const manifestResult = manifestResults[index];
    if (!manifestResult?.ok) continue;
    const manifestRecord = manifestResult.value;
    if (
      manifestRecord.event.id !== entry.activeManifestId ||
      manifestRecord.manifest.handle !== entry.handle ||
      manifestRecord.manifest.origin !== entry.origin ||
      canonicalBlockJson(manifestRecord.manifest.permissions) !==
        canonicalBlockJson(entry.permissions)
    ) {
      continue;
    }
    const blockAddress = blockCatalogAddress(relaySelfPubkey, entry.handle);
    if (!blockAddress) continue;
    items.push({
      blockAddress,
      catalogEventId: entry.catalogEventId,
      handle: entry.handle,
      manifestId: entry.activeManifestId,
      manifestRecord,
      name: manifestRecord.manifest.name,
      origin: entry.origin,
      permissions: entry.permissions,
      preview: entry.preview,
      publisherPubkey: manifestRecord.event.pubkey,
      recentUsage: {
        complete: recentMessages.complete,
        ...(recentUsage.get(entry.handle) ?? {
          count: recentUsageAvailable ? 0 : null,
          lastUsedAt: null,
        }),
      },
      status: entry.status,
      summary: entry.summary,
      workshop: entry.workshop,
    });
  }

  return items.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

const defaultDependencies: BlockCatalogDependencies = {
  async fetchCatalogEvents(relaySelfPubkey) {
    return relayClient.fetchEvents({
      kinds: [KIND_BLOCK_CATALOG_ENTRY],
      authors: [relaySelfPubkey],
      limit: 200,
    });
  },
  async fetchRecentMessages(channelIds) {
    const since = Math.floor(Date.now() / 1_000) - RECENT_USAGE_WINDOW_SECONDS;
    const batches: string[][] = [];
    for (
      let index = 0;
      index < channelIds.length;
      index += RELAY_FILTER_TAG_LIMIT
    ) {
      batches.push(channelIds.slice(index, index + RELAY_FILTER_TAG_LIMIT));
    }
    const results = await Promise.all(
      batches.map((channelBatch) =>
        relayClient.fetchEvents({
          kinds: [KIND_STREAM_MESSAGE],
          "#h": channelBatch,
          since,
          limit: 500,
        }),
      ),
    );
    return {
      complete: results.every((events) => events.length < 500),
      events: results.flat(),
    };
  },
  loadManifest(communityId, manifestId, relaySelfPubkey) {
    return loadBlockManifest({
      communityId,
      manifestId,
      relaySelfPubkey,
    });
  },
  relaySelf: getRelaySelf,
};

export function blockCatalogQueryKey(
  request: {
    channelIds: readonly string[];
    communityId: string;
    recentUsageAvailable?: boolean;
  } | null,
) {
  return [
    "block-catalog",
    request?.communityId ?? "",
    [...(request?.channelIds ?? [])].sort(),
    request?.recentUsageAvailable ?? true,
  ] as const;
}

export function useBlockCatalogQuery(
  request: {
    channelIds: readonly string[];
    communityId: string;
    recentUsageAvailable?: boolean;
  } | null,
) {
  return useQuery({
    queryKey: blockCatalogQueryKey(request),
    queryFn: () => {
      if (!request) throw new Error("Block catalog request is unavailable.");
      return loadBlockCatalog(request);
    },
    enabled: request !== null,
    staleTime: 60_000,
  });
}
