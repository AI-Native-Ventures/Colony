import { useQuery } from "@tanstack/react-query";

import type {
  BlockInstanceData,
  BlockManifest,
  BlockParseResult,
} from "./contracts";
import { loadBlockData } from "./blockData";
import {
  loadBlockManifest,
  type BlockManifestRequest,
} from "./blockRepository";
import { blockJsonSha256 } from "./blockValidation";

export type BlockDataRequest = {
  communityId: string;
  manifestId: string;
  manifest: BlockManifest;
  data: BlockInstanceData;
};

export function blockDataQueryKey(request: BlockDataRequest | null) {
  return [
    "block-data",
    request?.communityId ?? "",
    request?.manifestId ?? "",
    request ? blockJsonSha256(request.manifest.input_schema) : "",
    request?.data.type ?? "",
    request?.data.type === "external"
      ? request.data.sha256
      : request?.data.value,
  ] as const;
}

export function requireAvailableBlockResult<T>(
  result: BlockParseResult<T>,
): BlockParseResult<T> {
  if (!result.ok && result.code === "unavailable") {
    throw new Error(result.message);
  }
  return result;
}

export function useBlockManifest(
  request: BlockManifestRequest | null,
  enabled = true,
) {
  return useQuery({
    queryKey: [
      "block-manifest",
      request?.communityId ?? "",
      request?.manifestId ?? "",
    ],
    queryFn: async () => {
      if (!request) {
        throw new Error("Block manifest request is unavailable");
      }
      return requireAvailableBlockResult(await loadBlockManifest(request));
    },
    enabled: enabled && request !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

export function useBlockData(request: BlockDataRequest | null, enabled = true) {
  return useQuery<BlockParseResult<unknown>>({
    queryKey: blockDataQueryKey(request),
    queryFn: () => {
      if (!request) {
        throw new Error("Block data contract is unavailable");
      }
      return loadBlockData(request.manifest, request.data);
    },
    enabled: enabled && request !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
