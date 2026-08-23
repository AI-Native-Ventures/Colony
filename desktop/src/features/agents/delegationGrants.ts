import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_DELEGATION_GRANT } from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Reading active delegation grants (kind 30189).
 *
 * A grant is the owner saying "handle this category of decision
 * yourselves". It is NOT issued to an agent: the record carries no holder,
 * and the relay authorizes a decision by checking only that the signer sits
 * at leader or executive rank and that the cited grant is active, matching
 * category, and within cap (`interrupt_gate::enforce_decision_log_authority`).
 * Grants are therefore community-wide capabilities, and promoting an agent
 * to Team lead hands it every active grant, immediately.
 *
 * Trust mirrors `active_grant` in `crates/buzz-relay/src/interrupt_gate.rs`:
 * kind 30189 is client-writable, so ANY author can publish a head at a `d`
 * tag it does not own. Per grant id, candidates are scanned newest-first and
 * the first OWNER-authored head wins -- even when malformed -- rather than
 * falling back to an older head. A client that trusted the newest head
 * outright would display a grant the relay would refuse.
 */

export type DelegationGrant = {
  /** The `d` tag: this grant's stable id. */
  grantId: string;
  /** What kind of decision this delegates (lowercased). */
  category: string;
  /** The precise boundary of the delegation (lowercased). */
  scope: string;
  /** Optional spending cap in integer nanoUSD. */
  capNanoUsd: number | null;
  /** Whether this grant currently authorizes autonomous action. */
  active: boolean;
};

/**
 * Parse one grant head. Schema only: authorship is decided by the caller's
 * owner set, exactly as ingest decides it against its membership table.
 * Returns null for anything malformed rather than throwing.
 */
export function parseGrantEvent(event: RelayEvent): DelegationGrant | null {
  if (event.kind !== KIND_DELEGATION_GRANT) return null;
  const grantId = event.tags.find((tag) => tag[0] === "d")?.[1]?.trim();
  if (!grantId) return null;

  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    return null;
  }

  const readString = (key: string): string | null => {
    const value = content[key];
    return typeof value === "string" && value.trim().length > 0
      ? value.trim().toLowerCase()
      : null;
  };
  const category = readString("category");
  const scope = readString("scope");
  if (!category || !scope) return null;
  if (typeof content.active !== "boolean") return null;

  let capNanoUsd: number | null = null;
  const rawCap = content.cap_nano_usd;
  if (rawCap !== undefined) {
    if (typeof rawCap !== "number" || !Number.isInteger(rawCap) || rawCap < 0) {
      return null;
    }
    capNanoUsd = rawCap;
  }

  return { grantId, category, scope, capNanoUsd, active: content.active };
}

/**
 * Resolve the head this community trusts at each grant id: the first
 * owner-authored candidate walking newest-first, parsed when it survives the
 * schema. Malformed trusted heads are dropped -- the relay treats them as no
 * grant at all (`active_grant` returns the failed parse as `Ok(None)`), so
 * showing invented fields would be worse than omitting the row.
 */
function trustedGrantHeads(
  events: RelayEvent[],
  ownerPubkeys: ReadonlySet<string>,
): DelegationGrant[] {
  const candidatesByGrantId = new Map<string, RelayEvent[]>();
  for (const event of events) {
    if (event.kind !== KIND_DELEGATION_GRANT) continue;
    const grantId = event.tags.find((tag) => tag[0] === "d")?.[1]?.trim();
    if (!grantId) continue;
    const group = candidatesByGrantId.get(grantId);
    if (group) {
      group.push(event);
    } else {
      candidatesByGrantId.set(grantId, [event]);
    }
  }

  const grants: DelegationGrant[] = [];
  for (const [, candidates] of candidatesByGrantId) {
    // Same scan as the relay: newest-first, stop at the first owner-authored
    // head even if its content turns out malformed.
    const trusted = [...candidates]
      .sort((a, b) => b.created_at - a.created_at)
      .find((candidate) => ownerPubkeys.has(normalizePubkey(candidate.pubkey)));
    if (!trusted) continue;
    const parsed = parseGrantEvent(trusted);
    if (parsed) grants.push(parsed);
  }
  return grants.sort((a, b) => a.grantId.localeCompare(b.grantId));
}

/**
 * Every currently-active grant authored by a current owner. One grant per
 * `d` tag: the first owner-authored candidate walking newest-first.
 */
export function activeGrantsFromEvents(
  events: RelayEvent[],
  ownerPubkeys: ReadonlySet<string>,
): DelegationGrant[] {
  return trustedGrantHeads(events, ownerPubkeys).filter(
    (grant) => grant.active,
  );
}

/**
 * Every grant a current owner ever authored at its d tag, revoked ones
 * included. A revocation is a republished head with `active: false`, not a
 * deletion, and the record stays on the relay: hiding it would tell the owner
 * a grant history exists that does not. Same owner-authorship scan as
 * `activeGrantsFromEvents`; only the active filter differs.
 */
export function allGrantsFromEvents(
  events: RelayEvent[],
  ownerPubkeys: ReadonlySet<string>,
): DelegationGrant[] {
  return trustedGrantHeads(events, ownerPubkeys);
}

async function fetchDelegationGrantEvents(): Promise<RelayEvent[]> {
  const filter: RelaySubscriptionFilter = {
    kinds: [KIND_DELEGATION_GRANT],
    limit: 500,
  };
  return relayClient.fetchEvents(filter);
}

const DELEGATION_GRANTS_ROOT = "colony-delegation-grants" as const;

/** Community-scoped query key for the raw kind-30189 fetch. */
export function delegationGrantsQueryKey(communityId: string) {
  return [DELEGATION_GRANTS_ROOT, communityId] as const;
}

export { fetchDelegationGrantEvents };
