import { fetchBlockData } from "@/shared/api/blockData";

import type {
  BlockInstanceData,
  BlockManifest,
  BlockParseResult,
} from "./contracts";
import { validateBlockData } from "./blockValidation";

export type BlockDataLoader = (
  request: Extract<BlockInstanceData, { type: "external" }>,
) => Promise<Uint8Array>;

export async function loadBlockData(
  manifest: BlockManifest,
  data: BlockInstanceData,
  fetchExternal: BlockDataLoader = fetchBlockData,
): Promise<BlockParseResult<unknown>> {
  if (data.type === "inline") {
    return validateBlockData(manifest, data.value);
  }

  try {
    const url = new URL(data.url);
    if (url.protocol !== "https:" || url.hostname.length === 0) {
      return {
        ok: false,
        code: "invalid-tags",
        message: "External Block data must use HTTPS",
      };
    }
    const bytes = await fetchExternal(data);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        ok: false,
        code: "integrity-failed",
        message: "External Block data is not valid UTF-8",
      };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return {
        ok: false,
        code: "invalid-json",
        message: "External Block data is not valid JSON",
      };
    }
    return validateBlockData(manifest, value);
  } catch (error) {
    return {
      ok: false,
      code: "unavailable",
      message: `External Block data could not be loaded: ${String(error)}`,
    };
  }
}
