import type { RelayEvent } from "@/shared/api/types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBKEY_RE = /^[0-9a-f]{64}$/;
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export type AgentProposalData =
  | {
      mode: "create";
      requestId: string;
      channelId: string;
      displayName: string;
      systemPrompt: string;
    }
  | {
      mode: "update";
      requestId: string;
      channelId: string;
      agentName: string;
      displayName?: string;
      systemPrompt?: string;
      runtime?: string;
      provider?: string;
      model?: string;
      respondTo?: "owner-only" | "anyone";
    };

export type AgentProposalSafeAction = {
  requestId: string;
  definition: {
    id?: string;
    displayName: string;
    avatarUrl?: string;
    systemPrompt: string;
    runtime?: string;
    provider?: string;
    model?: string;
    behavior?: {
      respondTo?: "owner-only" | "allowlist" | "anyone";
      respondToAllowlist?: string[];
      parallelism?: number;
    };
  };
  runOn: { type: "local" } | { type: "provider"; id: string };
};

export type AgentProposalReceiptResult =
  | {
      outcome: "created" | "updated";
      definitionId: string;
      agentPubkey?: string;
      recovered: boolean;
    }
  | { outcome: "declined" }
  | { outcome: "failed"; message: string };

export type AgentProposalInstance = {
  event: RelayEvent;
  channelId: string;
  signerPubkey: string;
  manifestId: string;
  instanceId: string;
  processorPubkey: string;
  data: AgentProposalData;
};

type AgentProposalReviewListener = (
  proposal: AgentProposalInstance | null,
) => void;

const reviewListeners = new Set<AgentProposalReviewListener>();
let selectedProposal: AgentProposalInstance | null = null;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || isText(value);
}

function isSafeAvatarUrl(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  if (!isText(value)) return false;
  try {
    const url = new URL(value);
    return (
      HTTP_PROTOCOLS.has(url.protocol) &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function parseBehavior(
  value: unknown,
): AgentProposalSafeAction["definition"]["behavior"] | null | undefined {
  if (value === undefined) return undefined;
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["respondTo", "respondToAllowlist", "parallelism"])
  ) {
    return null;
  }
  const respondTo = value.respondTo;
  if (
    respondTo !== undefined &&
    respondTo !== "owner-only" &&
    respondTo !== "allowlist" &&
    respondTo !== "anyone"
  ) {
    return null;
  }
  const allowlist = value.respondToAllowlist;
  if (
    allowlist !== undefined &&
    (!Array.isArray(allowlist) ||
      allowlist.some(
        (pubkey) =>
          typeof pubkey !== "string" || !PUBKEY_RE.test(pubkey.toLowerCase()),
      ))
  ) {
    return null;
  }
  const parallelism = value.parallelism;
  if (
    parallelism !== undefined &&
    (!Number.isInteger(parallelism) ||
      (parallelism as number) < 1 ||
      (parallelism as number) > 32)
  ) {
    return null;
  }
  if (
    respondTo === "allowlist" &&
    (!Array.isArray(allowlist) || allowlist.length === 0)
  ) {
    return null;
  }
  return {
    ...(respondTo ? { respondTo } : {}),
    ...(Array.isArray(allowlist)
      ? {
          respondToAllowlist: [
            ...new Set(allowlist.map((pubkey) => pubkey.toLowerCase())),
          ],
        }
      : {}),
    ...(typeof parallelism === "number" ? { parallelism } : {}),
  };
}

/** Parse the exact no-secret data contract of a persisted Core Agent Proposal. */
export function parseAgentProposalData(
  value: unknown,
  instanceId: string,
): AgentProposalData | null {
  if (!UUID_RE.test(instanceId) || !isObject(value)) return null;
  if (
    !hasOnlyKeys(value, [
      "mode",
      "requestId",
      "channelId",
      "displayName",
      "systemPrompt",
      "agentName",
      "runtime",
      "provider",
      "model",
      "respondTo",
    ]) ||
    value.requestId !== instanceId ||
    !isText(value.channelId)
  ) {
    return null;
  }

  if (value.mode === "create") {
    if (
      !hasOnlyKeys(value, [
        "mode",
        "requestId",
        "channelId",
        "displayName",
        "systemPrompt",
      ]) ||
      !isText(value.displayName) ||
      !isText(value.systemPrompt)
    ) {
      return null;
    }
    return {
      mode: "create",
      requestId: instanceId,
      channelId: value.channelId,
      displayName: value.displayName,
      systemPrompt: value.systemPrompt,
    };
  }

  if (
    value.mode !== "update" ||
    !isText(value.agentName) ||
    !isOptionalText(value.displayName) ||
    !isOptionalText(value.systemPrompt) ||
    !isOptionalText(value.runtime) ||
    !isOptionalText(value.provider) ||
    !isOptionalText(value.model) ||
    (value.respondTo !== undefined &&
      value.respondTo !== "owner-only" &&
      value.respondTo !== "anyone")
  ) {
    return null;
  }
  const edits = [
    value.displayName,
    value.systemPrompt,
    value.runtime,
    value.provider,
    value.model,
    value.respondTo,
  ].filter((candidate) => candidate !== undefined);
  if (edits.length === 0) return null;
  return {
    mode: "update",
    requestId: instanceId,
    channelId: value.channelId,
    agentName: value.agentName,
    ...(value.displayName !== undefined
      ? { displayName: value.displayName }
      : {}),
    ...(value.systemPrompt !== undefined
      ? { systemPrompt: value.systemPrompt }
      : {}),
    ...(value.runtime !== undefined ? { runtime: value.runtime } : {}),
    ...(value.provider !== undefined ? { provider: value.provider } : {}),
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.respondTo !== undefined ? { respondTo: value.respondTo } : {}),
  };
}

/**
 * Parse a complete canonical Agent Proposal action.
 *
 * Unknown fields are rejected at every level. Creation must not carry a
 * definition ID; updates must target the one definition resolved by review.
 */
export function parseAgentProposalSafeAction(
  value: unknown,
  proposal: AgentProposalData,
  expectedDefinitionId?: string,
): AgentProposalSafeAction | null {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["requestId", "definition", "runOn"]) ||
    value.requestId !== proposal.requestId ||
    !isObject(value.definition) ||
    !hasOnlyKeys(value.definition, [
      "id",
      "displayName",
      "avatarUrl",
      "systemPrompt",
      "runtime",
      "provider",
      "model",
      "behavior",
    ]) ||
    !isText(value.definition.displayName) ||
    typeof value.definition.systemPrompt !== "string" ||
    !isSafeAvatarUrl(value.definition.avatarUrl) ||
    !isOptionalText(value.definition.runtime) ||
    !isOptionalText(value.definition.provider) ||
    !isOptionalText(value.definition.model)
  ) {
    return null;
  }
  const behavior = parseBehavior(value.definition.behavior);
  if (behavior === null) return null;

  if (
    (proposal.mode === "create" && value.definition.id !== undefined) ||
    (proposal.mode === "update" &&
      (!isText(value.definition.id) ||
        !expectedDefinitionId ||
        value.definition.id !== expectedDefinitionId))
  ) {
    return null;
  }

  if (
    !isObject(value.runOn) ||
    !hasOnlyKeys(value.runOn, ["type", "id"]) ||
    (value.runOn.type !== "local" && value.runOn.type !== "provider") ||
    (value.runOn.type === "local" && value.runOn.id !== undefined) ||
    (value.runOn.type === "provider" && !isText(value.runOn.id))
  ) {
    return null;
  }

  return {
    requestId: proposal.requestId,
    definition: {
      ...(proposal.mode === "update"
        ? { id: value.definition.id as string }
        : {}),
      displayName: value.definition.displayName,
      ...(value.definition.avatarUrl
        ? { avatarUrl: value.definition.avatarUrl }
        : {}),
      systemPrompt: value.definition.systemPrompt,
      ...(value.definition.runtime
        ? { runtime: value.definition.runtime }
        : {}),
      ...(value.definition.provider
        ? { provider: value.definition.provider }
        : {}),
      ...(value.definition.model ? { model: value.definition.model } : {}),
      ...(behavior ? { behavior } : {}),
    },
    runOn:
      value.runOn.type === "local"
        ? { type: "local" }
        : { type: "provider", id: value.runOn.id as string },
  };
}

export function parseAgentProposalDecline(
  value: unknown,
  _proposal: AgentProposalData,
): { reason?: string } | null {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["reason"]) ||
    (value.reason !== undefined &&
      (typeof value.reason !== "string" || value.reason.length > 2_000))
  ) {
    return null;
  }
  return value.reason === undefined ? {} : { reason: value.reason };
}

/** Closed Core presentation entry used by the generic Blocks renderer. */
export function openAgentProposalReview(proposal: AgentProposalInstance) {
  selectedProposal = proposal;
  for (const listener of reviewListeners) listener(selectedProposal);
}

export function subscribeAgentProposalReview(
  listener: AgentProposalReviewListener,
) {
  reviewListeners.add(listener);
  listener(selectedProposal);
  return () => {
    reviewListeners.delete(listener);
  };
}

export function closeAgentProposalReview() {
  selectedProposal = null;
  for (const listener of reviewListeners) listener(null);
}

export function resetAgentProposalReview() {
  closeAgentProposalReview();
  reviewListeners.clear();
}
