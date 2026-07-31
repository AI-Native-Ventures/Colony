import type { BlockCatalogItem } from "@/features/blocks/blockCatalog";
import { normalizeBlockHandle } from "@/features/blocks/blockValidation";
import { KIND_BLOCK_CATALOG_ENTRY } from "@/shared/constants/kinds";

const EVENT_ID_RE = /^[0-9a-f]{64}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/;

export type NewMessageRouteSearch = {
  blockAddress?: string;
  blockHandle?: string;
  blockManifestId?: string;
};

export type VerifiedBlockHandoff = {
  blockAddress: string;
  displayName: string;
  manifestId: string;
};

/**
 * Block workshop handoffs are all-or-nothing. A malformed coordinate, handle,
 * or active manifest ID is discarded before any value reaches the composer.
 */
export function validateNewMessageSearch(
  search: Record<string, unknown>,
): NewMessageRouteSearch {
  if (
    typeof search.blockAddress !== "string" ||
    typeof search.blockHandle !== "string" ||
    typeof search.blockManifestId !== "string"
  ) {
    return {};
  }
  const normalizedHandle = normalizeBlockHandle(search.blockHandle);
  if (
    !normalizedHandle.ok ||
    normalizedHandle.value !== search.blockHandle ||
    !EVENT_ID_RE.test(search.blockManifestId)
  ) {
    return {};
  }

  const [rawKind, publisherPubkey, addressHandle, ...remainder] =
    search.blockAddress.split(":");
  if (
    remainder.length > 0 ||
    rawKind !== String(KIND_BLOCK_CATALOG_ENTRY) ||
    !PUBKEY_RE.test(publisherPubkey ?? "") ||
    addressHandle !== search.blockHandle
  ) {
    return {};
  }

  return {
    blockAddress: search.blockAddress,
    blockHandle: search.blockHandle,
    blockManifestId: search.blockManifestId,
  };
}

/**
 * URL syntax is untrusted input, not catalog authority. Resolve it against the
 * current relay-authored active head before registering a typed Block mention.
 */
export function resolveVerifiedBlockHandoff(
  search: NewMessageRouteSearch,
  items: readonly BlockCatalogItem[],
): VerifiedBlockHandoff | null {
  if (!search.blockAddress || !search.blockHandle || !search.blockManifestId) {
    return null;
  }
  const item = items.find(
    (candidate) =>
      candidate.status === "active" &&
      candidate.blockAddress === search.blockAddress &&
      candidate.handle === search.blockHandle &&
      candidate.manifestId === search.blockManifestId,
  );
  return item
    ? {
        blockAddress: item.blockAddress,
        displayName: item.handle,
        manifestId: item.manifestId,
      }
    : null;
}
