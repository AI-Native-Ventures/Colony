import { verifyEvent } from "nostr-tools/pure";

import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_BLOCK_ACTION,
  KIND_BLOCK_RECEIPT,
  KIND_STREAM_MESSAGE,
} from "@/shared/constants/kinds";

import {
  BLOCK_EXTERNAL_DATA_MAX_BYTES,
  BLOCK_INLINE_DATA_MAX_BYTES,
  type BlockActionRef,
  type BlockFailureCode,
  type BlockInstanceRef,
  type BlockParseResult,
  type BlockReceiptRef,
  type BlockReceiptStatus,
} from "./contracts";
import { canonicalBlockJson, normalizeBlockHandle } from "./blockValidation";

const EVENT_ID_RE = /^[0-9a-f]{64}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_STATUSES = new Set<BlockReceiptStatus>([
  "succeeded",
  "denied",
  "failed",
  "timed-out",
]);

function failure<T>(
  message: string,
  code: BlockFailureCode = "invalid-tags",
): BlockParseResult<T> {
  return { ok: false, code, message };
}

function tagsNamed(tags: string[][], name: string): string[][] {
  return tags.filter((tag) => tag[0] === name);
}

function exactChannelId(event: RelayEvent): string | null {
  const channels = tagsNamed(event.tags, "h");
  return channels.length === 1 && channels[0]?.length === 2
    ? (channels[0]?.[1] ?? null)
    : null;
}

function validSignedEvent(event: RelayEvent): boolean {
  try {
    // Clone the wire fields so a caller-supplied nostr-tools verification
    // memo cannot cross this UI authority boundary.
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

function exactMarkedEvent(
  tags: string[][],
  marker: string,
): BlockParseResult<string> {
  const matches = tags.filter((tag) => tag[0] === "e" && tag[3] === marker);
  if (matches.length !== 1 || matches[0]?.length !== 4) {
    return failure(`expected exactly one ${marker} event reference`);
  }
  const eventId = matches[0]?.[1]?.toLowerCase() ?? "";
  return EVENT_ID_RE.test(eventId)
    ? { ok: true, value: eventId }
    : failure(`invalid ${marker} event ID`);
}

function parseAttention(
  tags: string[][],
  state: "required" | "resolved",
): BlockParseResult<boolean> {
  const attention = tagsNamed(tags, "block-attention");
  if (attention.length > 1) {
    return failure("duplicate block-attention tags are forbidden");
  }
  if (attention.length === 0) {
    return { ok: true, value: false };
  }
  const tag = attention[0];
  if (tag?.length !== 3 || tag[1] !== "1" || tag[2] !== state) {
    return failure(`invalid block-attention ${state} marker`);
  }
  return { ok: true, value: true };
}

/** Returns whether an event should use the inline Block renderer. */
export function isBlockMessage(event: {
  kind?: number;
  tags?: string[][];
}): boolean {
  return (
    event.kind === KIND_STREAM_MESSAGE &&
    (event.tags?.some((tag) => tag[0] === "block") ?? false)
  );
}

export function parseBlockInstance(
  tags: string[][],
): BlockParseResult<BlockInstanceRef> {
  try {
    const blockTags = tagsNamed(tags, "block");
    if (blockTags.length !== 1 || blockTags[0]?.length !== 5) {
      return failure("expected exactly one Block instance tag");
    }
    const [, schemaVersion, rawHandle, rawManifestId, instanceId] =
      blockTags[0] ?? [];
    if (schemaVersion !== "1") {
      return failure("unsupported Block instance schema version");
    }
    const handle = normalizeBlockHandle(rawHandle ?? "");
    if (!handle.ok || handle.value !== rawHandle) {
      return failure("Block instance handle must already be normalized");
    }
    const manifestId = rawManifestId?.toLowerCase() ?? "";
    if (!EVENT_ID_RE.test(manifestId)) {
      return failure("invalid Block manifest event ID");
    }
    if (!instanceId || !UUID_RE.test(instanceId)) {
      return failure("invalid Block instance ID");
    }

    const manifestEvent = exactMarkedEvent(tags, "block");
    if (!manifestEvent.ok) return manifestEvent;
    if (manifestEvent.value !== manifestId) {
      return failure("Block manifest references do not match");
    }

    const inlineTags = tagsNamed(tags, "block-data");
    const externalTags = tagsNamed(tags, "block-data-ref");
    if (inlineTags.length + externalTags.length !== 1) {
      return failure("Block instance requires exactly one data tag");
    }

    let data: BlockInstanceRef["data"];
    if (inlineTags.length === 1) {
      const tag = inlineTags[0];
      if (tag?.length !== 2 || tag[1] === undefined) {
        return failure("invalid inline Block data tag");
      }
      if (
        new TextEncoder().encode(tag[1]).byteLength >
        BLOCK_INLINE_DATA_MAX_BYTES
      ) {
        return failure("inline Block data exceeds 32 KiB");
      }
      let value: unknown;
      try {
        value = JSON.parse(tag[1]);
      } catch {
        return failure("inline Block data is not JSON", "invalid-json");
      }
      if (canonicalBlockJson(value) !== tag[1]) {
        return failure("inline Block data must use canonical JSON");
      }
      data = { type: "inline", value };
    } else {
      const tag = externalTags[0];
      if (tag?.length !== 5) {
        return failure("invalid external Block data tag");
      }
      const [, url, mime, sha256, rawByteSize] = tag;
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url ?? "");
      } catch {
        return failure("external Block data URL is invalid");
      }
      if (
        parsedUrl.protocol !== "https:" ||
        parsedUrl.hostname.length === 0 ||
        mime !== "application/json" ||
        !SHA256_RE.test(sha256 ?? "")
      ) {
        return failure("external Block data reference is invalid");
      }
      const byteSize = Number(rawByteSize);
      if (
        !Number.isSafeInteger(byteSize) ||
        byteSize < 1 ||
        byteSize > BLOCK_EXTERNAL_DATA_MAX_BYTES
      ) {
        return failure("external Block data size is invalid");
      }
      data = {
        type: "external",
        url: url ?? "",
        mime,
        sha256: sha256 ?? "",
        byteSize,
      };
    }

    const attentionRequired = parseAttention(tags, "required");
    if (!attentionRequired.ok) return attentionRequired;
    const participantTags = tagsNamed(tags, "p");
    const validParticipants = participantTags
      .map((tag) => tag[1]?.toLowerCase() ?? "")
      .filter((pubkey) => PUBKEY_RE.test(pubkey));
    if (
      attentionRequired.value &&
      (participantTags.length !== 1 || validParticipants.length !== 1)
    ) {
      return failure(
        "required attention needs exactly one decision-maker p tag",
      );
    }
    const processorTags = tagsNamed(tags, "block-processor");
    if (processorTags.length > 1) {
      return failure("duplicate block-processor tags are forbidden");
    }
    let explicitProcessor: string | null = null;
    if (processorTags.length === 1) {
      const tag = processorTags[0];
      const candidate = tag?.[2]?.toLowerCase() ?? "";
      if (tag?.length !== 3 || tag[1] !== "1" || !PUBKEY_RE.test(candidate)) {
        return failure("invalid block-processor tag");
      }
      explicitProcessor = candidate;
    }
    const legacyProcessor =
      participantTags.length === 1 ? (validParticipants[0] ?? null) : null;
    return {
      ok: true,
      value: {
        handle: handle.value,
        manifestId,
        instanceId,
        data,
        attentionRequired: attentionRequired.value,
        decisionMakerPubkey: attentionRequired.value
          ? (validParticipants[0] ?? null)
          : null,
        processorPubkey: explicitProcessor ?? legacyProcessor,
      },
    };
  } catch (error) {
    return failure(`Block instance parsing failed safely: ${String(error)}`);
  }
}

export function parseBlockAction(
  tags: string[][],
): BlockParseResult<BlockActionRef> {
  try {
    const actionTags = tagsNamed(tags, "block-action");
    if (actionTags.length !== 1 || actionTags[0]?.length !== 5) {
      return failure("expected exactly one Block action tag");
    }
    const [, version, actionId, instanceId, idempotencyKey] =
      actionTags[0] ?? [];
    if (
      version !== "1" ||
      !actionId ||
      !UUID_RE.test(instanceId ?? "") ||
      !UUID_RE.test(idempotencyKey ?? "")
    ) {
      return failure("invalid Block action tag");
    }
    const instanceEventId = exactMarkedEvent(tags, "block-instance");
    if (!instanceEventId.ok) return instanceEventId;
    const manifestId = exactMarkedEvent(tags, "block-manifest");
    if (!manifestId.ok) return manifestId;
    const processors = tagsNamed(tags, "p");
    const processorPubkey = processors[0]?.[1]?.toLowerCase() ?? "";
    if (processors.length !== 1 || !PUBKEY_RE.test(processorPubkey)) {
      return failure("Block action requires exactly one processor p tag");
    }
    return {
      ok: true,
      value: {
        actionId,
        instanceId: instanceId ?? "",
        idempotencyKey: idempotencyKey ?? "",
        instanceEventId: instanceEventId.value,
        manifestId: manifestId.value,
        processorPubkey,
      },
    };
  } catch (error) {
    return failure(`Block action parsing failed safely: ${String(error)}`);
  }
}

export function parseBlockReceipt(
  tags: string[][],
): BlockParseResult<BlockReceiptRef> {
  try {
    const receiptTags = tagsNamed(tags, "block-receipt");
    if (receiptTags.length !== 1 || receiptTags[0]?.length !== 5) {
      return failure("expected exactly one Block receipt tag");
    }
    const [, version, instanceId, idempotencyKey, rawStatus] =
      receiptTags[0] ?? [];
    if (
      version !== "1" ||
      !UUID_RE.test(instanceId ?? "") ||
      !UUID_RE.test(idempotencyKey ?? "") ||
      !RECEIPT_STATUSES.has(rawStatus as BlockReceiptStatus)
    ) {
      return failure("invalid Block receipt tag");
    }
    const actionEventId = exactMarkedEvent(tags, "block-action");
    if (!actionEventId.ok) return actionEventId;
    const instanceEventId = exactMarkedEvent(tags, "block-instance");
    if (!instanceEventId.ok) return instanceEventId;
    const resolvesAttention = parseAttention(tags, "resolved");
    if (!resolvesAttention.ok) return resolvesAttention;
    if (
      resolvesAttention.value &&
      (rawStatus === "failed" || rawStatus === "timed-out")
    ) {
      return failure(`${rawStatus} receipts cannot resolve durable attention`);
    }
    return {
      ok: true,
      value: {
        instanceId: instanceId ?? "",
        idempotencyKey: idempotencyKey ?? "",
        status: rawStatus as BlockReceiptStatus,
        actionEventId: actionEventId.value,
        instanceEventId: instanceEventId.value,
        resolvesAttention: resolvesAttention.value,
      },
    };
  } catch (error) {
    return failure(`Block receipt parsing failed safely: ${String(error)}`);
  }
}

/**
 * A receipt may affect UI state only when its signer is the processor pinned
 * by the exact action it references, and both envelopes describe one action.
 */
export function isAuthorizedBlockReceipt(
  actionEvent: RelayEvent | undefined,
  receiptEvent: RelayEvent,
  instanceEvent: RelayEvent | undefined,
): boolean {
  if (
    !actionEvent ||
    !instanceEvent ||
    actionEvent.kind !== KIND_BLOCK_ACTION ||
    receiptEvent.kind !== KIND_BLOCK_RECEIPT ||
    instanceEvent.kind !== KIND_STREAM_MESSAGE ||
    !validSignedEvent(actionEvent) ||
    !validSignedEvent(receiptEvent) ||
    !validSignedEvent(instanceEvent)
  ) {
    return false;
  }
  const action = parseBlockAction(actionEvent.tags);
  const receipt = parseBlockReceipt(receiptEvent.tags);
  const instance = parseBlockInstance(instanceEvent.tags);
  if (!action.ok || !receipt.ok || !instance.ok) return false;
  const actionChannel = exactChannelId(actionEvent);
  const receiptChannel = exactChannelId(receiptEvent);
  const instanceChannel = exactChannelId(instanceEvent);
  if (
    !actionChannel ||
    actionChannel !== receiptChannel ||
    actionChannel !== instanceChannel
  ) {
    return false;
  }

  return (
    receiptEvent.pubkey.toLowerCase() === action.value.processorPubkey &&
    receipt.value.actionEventId === actionEvent.id.toLowerCase() &&
    receipt.value.instanceEventId === action.value.instanceEventId &&
    receipt.value.instanceEventId === instanceEvent.id.toLowerCase() &&
    receipt.value.instanceId === action.value.instanceId &&
    receipt.value.instanceId === instance.value.instanceId &&
    receipt.value.idempotencyKey === action.value.idempotencyKey &&
    action.value.manifestId === instance.value.manifestId &&
    action.value.processorPubkey === instance.value.processorPubkey
  );
}
