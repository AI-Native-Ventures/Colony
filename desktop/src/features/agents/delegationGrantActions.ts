import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { KIND_DELEGATION_GRANT } from "@/shared/constants/kinds";
import type { DelegationGrant } from "@/features/agents/delegationGrants";

/**
 * Creating and revoking delegation grants (kind 30189), owner-signed.
 *
 * A grant carries NO holder. It is a community-wide capability: the relay
 * authorizes a decision by checking only that the signer sits at leader or
 * executive rank and that the cited grant is active, category-matched, and
 * within cap (`interrupt_gate::enforce_decision_log_authority`). Revoking is
 * republishing the same `d` tag with `active: false`; nothing is deleted.
 *
 * The checks below mirror `parse_grant` in `crates/buzz-core/src/interrupt.rs`
 * so the owner learns a refusal BEFORE signing, not after the relay bounces
 * the event. They are a courtesy, never the authority: the relay re-checks
 * schema and owner authorship at ingest and its verdict wins.
 */

/**
 * Mirror of `HARD_LIST_CATEGORIES`
 * (`crates/buzz-core/src/interrupt.rs`, the immutable escalation categories:
 * spend, external_send, hiring, legal, pricing, deletion, vendor). These must
 * always reach a human owner, so no grant may ever delegate them. Keep in
 * sync with the Rust table; do not extend it here.
 */
export const HARD_LIST_CATEGORIES: readonly string[] = [
  "spend",
  "external_send",
  "hiring",
  "legal",
  "pricing",
  "deletion",
  "vendor",
];

/** Mirror of `VAGUE_GRANT_SCOPES`: a wildcard grant is no policy at all. */
const VAGUE_GRANT_SCOPES: readonly string[] = ["*", "all"];

export type DelegationGrantDraft = {
  /** The `d` tag: this grant's stable id. */
  grantId: string;
  category: string;
  scope: string;
  /** Spending cap in integer nanoUSD; null publishes without one. */
  capNanoUsd: number | null;
};

function isHardListCategory(category: string): boolean {
  return HARD_LIST_CATEGORIES.includes(category.toLowerCase());
}

/**
 * The first problem with a draft, or null when the relay's schema would
 * accept it. Case handling mirrors `parse_grant`: both hard-list and
 * wildcard checks fold ASCII case.
 */
export function delegationGrantDraftProblem(
  draft: DelegationGrantDraft,
): string | null {
  if (draft.grantId.trim().length === 0) {
    return "A delegation id is required.";
  }
  const category = draft.category.trim();
  if (category.length === 0) {
    return "A category is required: what kind of decision this delegates.";
  }
  if (isHardListCategory(category)) {
    return `category "${category}" is on the hard list and can never be delegated`;
  }
  const scope = draft.scope.trim();
  if (scope.length === 0) {
    return "A scope is required: the precise boundary of the delegation.";
  }
  if (VAGUE_GRANT_SCOPES.includes(scope.toLowerCase())) {
    return `grant scope must be specific, not a wildcard: ${scope}`;
  }
  if (
    draft.capNanoUsd !== null &&
    (!Number.isInteger(draft.capNanoUsd) || draft.capNanoUsd < 0)
  ) {
    return "cap_nano_usd must be a non-negative integer";
  }
  return null;
}

/**
 * The unsigned event template for a grant head. Category and scope are
 * published folded to lowercase, matching what the relay stores and every
 * reader displays back. Revocation is this same template with `active: false`
 * at the same `d` tag -- a republished head, not a delete.
 */
export function buildDelegationGrantEvent(
  draft: DelegationGrantDraft & { active: boolean },
): { kind: number; content: string; tags: string[][] } {
  const content: Record<string, unknown> = {
    category: draft.category.trim().toLowerCase(),
    scope: draft.scope.trim().toLowerCase(),
    active: draft.active,
  };
  if (draft.capNanoUsd !== null) {
    content.cap_nano_usd = draft.capNanoUsd;
  }
  return {
    kind: KIND_DELEGATION_GRANT,
    content: JSON.stringify(content),
    tags: [["d", draft.grantId.trim()]],
  };
}

async function publishGrantHead(
  draft: DelegationGrantDraft & { active: boolean },
): Promise<string> {
  const problem = delegationGrantDraftProblem(draft);
  if (problem !== null) {
    throw new Error(problem);
  }
  const event = await signRelayEvent(buildDelegationGrantEvent(draft));
  await relayClient.publishEvent(
    event,
    "Timed out while publishing the delegation.",
    "Failed to publish the delegation.",
  );
  return event.id;
}

/** Publish a new (or superseding) ACTIVE grant head at this `d` tag. */
export function publishDelegationGrant(draft: DelegationGrantDraft) {
  return publishGrantHead({ ...draft, active: true });
}

/**
 * Revoke an existing grant: republish its exact terms with `active: false`
 * at the same `d` tag. Takes the grant as read from the relay so the
 * revocation cannot silently alter what it revokes.
 */
export function revokeDelegationGrant(grant: DelegationGrant) {
  return publishGrantHead({
    grantId: grant.grantId,
    category: grant.category,
    scope: grant.scope,
    capNanoUsd: grant.capNanoUsd,
    active: false,
  });
}
