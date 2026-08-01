import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_BLOCK_ACTION } from "@/shared/constants/kinds";

const HEX_64 = /^[0-9a-f]{64}$/;
const ACTION_ID = /^[a-z0-9._-]{1,128}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_KEY =
  /(?:^|[_-])(secret|private|credential|token|password|api[_-]?key)(?:$|[_-])/i;
const inFlightActions = new Map<string, Promise<RelayEvent>>();
let blockActionCommunityGeneration = 0;

export type BlockActionRequest = {
  channelId: string;
  instanceEventId: string;
  manifestId: string;
  instanceId: string;
  actionId: string;
  processorPubkey: string;
  data: unknown;
  idempotencyKey?: string;
};

type BlockActionDependencies = {
  sign: typeof signRelayEvent;
  publish: (event: RelayEvent) => Promise<RelayEvent>;
  randomUuid: () => string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function canonicalBlockJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Block actions cannot contain non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalBlockJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalBlockJson(value[key] as unknown)}`,
      )
      .join(",")}}`;
  }
  throw new Error("Block actions must contain JSON values only.");
}

export function containsSecretBearingField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSecretBearingField);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, child]) => SECRET_KEY.test(key) || containsSecretBearingField(child),
  );
}

export function isRetryableBlockActionTransportError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (
    /terminal|auth(?:entication|orization)?|permission|forbidden|rejected|invalid|rate[- ]limit/i.test(
      message,
    )
  ) {
    return false;
  }
  if (/\b(?:active )?community changed\b|\bcommunity switch\b/i.test(message)) {
    return true;
  }
  return /timed out|\bnetwork\b|\bdns\b|\bwebsocket\b|\bsocket (?:is )?not connected\b|\bconnection (?:was )?(?:closed|lost|reset|refused)\b|\bdisconnected\b|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(
    message,
  );
}

function assertActionRequest(request: BlockActionRequest) {
  if (!HEX_64.test(request.instanceEventId)) {
    throw new Error("Block action instance event ID is invalid.");
  }
  if (!HEX_64.test(request.manifestId)) {
    throw new Error("Block action manifest ID is invalid.");
  }
  if (!HEX_64.test(request.processorPubkey)) {
    throw new Error("Block action processor is invalid.");
  }
  if (!ACTION_ID.test(request.actionId)) {
    throw new Error("Block action ID is invalid.");
  }
  if (!UUID.test(request.instanceId)) {
    throw new Error("Block instance ID is invalid.");
  }
  if (containsSecretBearingField(request.data)) {
    throw new Error("Block action input contains a secret-bearing field.");
  }
}

export function createBlockActionSubmitter(
  dependencies: BlockActionDependencies,
) {
  return async function submit(request: BlockActionRequest) {
    assertActionRequest(request);
    const communityGeneration = blockActionCommunityGeneration;
    const lockKey = `${request.instanceEventId}:${request.actionId}`;
    const existing = inFlightActions.get(lockKey);
    if (existing) {
      return existing;
    }

    const pending = (async () => {
      const idempotencyKey =
        request.idempotencyKey ?? dependencies.randomUuid().toLowerCase();
      if (!UUID.test(idempotencyKey)) {
        throw new Error("Block action idempotency key is invalid.");
      }
      const event = await dependencies.sign({
        kind: KIND_BLOCK_ACTION,
        content: canonicalBlockJson(request.data),
        tags: [
          ["h", request.channelId],
          ["p", request.processorPubkey],
          ["e", request.instanceEventId, "", "block-instance"],
          ["e", request.manifestId, "", "block-manifest"],
          [
            "block-action",
            "1",
            request.actionId,
            request.instanceId,
            idempotencyKey,
          ],
        ],
      });
      if (communityGeneration !== blockActionCommunityGeneration) {
        throw new Error(
          "Block action cancelled because the active community changed.",
        );
      }
      return dependencies.publish(event);
    })();

    inFlightActions.set(lockKey, pending);
    try {
      return await pending;
    } finally {
      if (inFlightActions.get(lockKey) === pending) {
        inFlightActions.delete(lockKey);
      }
    }
  };
}

export const submitBlockAction = createBlockActionSubmitter({
  sign: signRelayEvent,
  publish: (event) =>
    relayClient.publishEvent(
      event,
      "Timed out while submitting the Block action.",
      "Failed to submit the Block action.",
    ),
  randomUuid: () => crypto.randomUUID(),
});

export type ApprovalProposal = {
  action: string;
  destination: string;
  content: unknown;
  expires_at: number;
};

export function resolveApprovalActionInputs(
  value: unknown,
  nowSeconds: number,
):
  | {
      ok: true;
      inputs: ReadonlyMap<string, unknown>;
    }
  | { ok: false; reason: string } {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "The approval proposal is invalid." };
  }
  const { action, destination, content, expires_at: expiresAt, status } = value;
  if (
    typeof action !== "string" ||
    typeof destination !== "string" ||
    typeof content !== "string" ||
    !Number.isSafeInteger(expiresAt) ||
    status !== "pending"
  ) {
    return {
      ok: false,
      reason:
        status === "approved" || status === "denied"
          ? "This approval has already been resolved."
          : "The approval proposal is invalid.",
    };
  }
  const proposal: ApprovalProposal = {
    action,
    destination,
    content,
    expires_at: expiresAt as number,
  };
  const validation = validateApprovalGrant({
    current: proposal,
    expected: proposal,
    nowSeconds,
  });
  if (!validation.ok) return validation;
  return {
    ok: true,
    inputs: new Map<string, unknown>([
      ["approval.approve", { approval_hash: validation.approvalHash }],
      ["approval.deny", {}],
    ]),
  };
}

export function resolveApprovalActionInputForSubmission(
  value: unknown,
  actionId: string,
  nowSeconds: number,
):
  | { ok: true; input: unknown }
  | {
      ok: false;
      reason: string;
    } {
  const current = resolveApprovalActionInputs(value, nowSeconds);
  if (!current.ok) return current;
  if (!current.inputs.has(actionId)) {
    return { ok: false, reason: "This approval action is not available." };
  }
  return { ok: true, input: current.inputs.get(actionId) };
}

export function computeApprovalHash(proposal: ApprovalProposal) {
  return bytesToHex(
    sha256(new TextEncoder().encode(canonicalBlockJson(proposal))),
  );
}

export function validateApprovalGrant(input: {
  current: ApprovalProposal;
  expected: ApprovalProposal;
  expectedHash?: string;
  nowSeconds: number;
}) {
  const currentCanonical = canonicalBlockJson(input.current);
  const expectedCanonical = canonicalBlockJson(input.expected);
  if (currentCanonical !== expectedCanonical) {
    return { ok: false as const, reason: "The proposed action changed." };
  }
  if (input.current.expires_at <= input.nowSeconds) {
    return { ok: false as const, reason: "This approval has expired." };
  }
  const approvalHash = computeApprovalHash(input.current);
  if (input.expectedHash && input.expectedHash !== approvalHash) {
    return {
      ok: false as const,
      reason: "The approval hash no longer matches.",
    };
  }
  return { ok: true as const, approvalHash };
}

export function resetInFlightBlockActions() {
  blockActionCommunityGeneration += 1;
  inFlightActions.clear();
}
