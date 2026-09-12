import type { EmployeeHead } from "@/features/agents/employeeHeads";
import {
  trustedManagedAgentHeads,
  type ManagedAgentHead,
} from "@/features/agents/managedAgentHeads";
import type { ManagedAgent, RelayEvent } from "@/shared/api/types";
import {
  adoptProvisionedEmployees,
  type ProvisionedAdoption,
} from "@/shared/api/tauri";
import { normalizePubkey } from "@/shared/lib/pubkey";

const PROVISIONED_WEBSITE_HANDLES = new Set([
  "website-manager",
  "website-researcher",
  "website-designer-builder",
  "website-reviewer",
]);
const HEX_64 = /^[0-9a-f]{64}$/;

export type ProvisionedMentionMetadata = {
  employeeHeads: ReadonlyMap<string, EmployeeHead> | undefined;
  managedHeads: readonly RelayEvent[] | undefined;
  ownerPubkeys: ReadonlySet<string>;
};

export type ProvisionedMentionReconciliationInput = {
  mentionPubkeys: readonly string[];
  managedAgentsByPubkey: Map<string, ManagedAgent>;
  preparedManagedAgents: readonly ManagedAgent[];
  getCachedMetadata: () => ProvisionedMentionMetadata;
  refreshMetadata: () => Promise<ProvisionedMentionMetadata>;
  refreshManagedAgents: () => Promise<ManagedAgent[]>;
  adopt: () => Promise<ProvisionedAdoption[]>;
  scopeStillCurrent: () => boolean;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback;
}

/**
 * Build a handle-to-pubkey map only from relay-proven provisioned identities.
 * Employee heads are relay-minted; managed-agent heads are accepted only
 * after `trustedManagedAgentHeads` has applied its owner/self-signature gate.
 * Multiple identities claiming one Website role are ambiguous and omitted so
 * an unrelated agent can never be adopted by display name or role alone.
 */
function provisionedWebsitePubkeysByHandle(
  metadata: ProvisionedMentionMetadata,
): Map<string, string> {
  const byHandle = new Map<string, string>();
  const ambiguous = new Set<string>();
  const add = (rawHandle: string, rawPubkey: string) => {
    const handle = rawHandle.trim().toLowerCase();
    const pubkey = normalizePubkey(rawPubkey);
    if (
      !PROVISIONED_WEBSITE_HANDLES.has(handle) ||
      !HEX_64.test(pubkey) ||
      ambiguous.has(handle)
    ) {
      return;
    }
    const current = byHandle.get(handle);
    if (current && current !== pubkey) {
      byHandle.delete(handle);
      ambiguous.add(handle);
      return;
    }
    byHandle.set(handle, pubkey);
  };

  for (const employee of metadata.employeeHeads?.values() ?? []) {
    if (employee.provisioned) add(employee.role, employee.pubkey);
  }

  const provisionedEmployeePubkeys = new Set(
    [...(metadata.employeeHeads?.values() ?? [])]
      .filter((head) => Boolean(head.provisioned))
      .map((head) => normalizePubkey(head.pubkey)),
  );
  const trustedHeads: ManagedAgentHead[] = metadata.managedHeads
    ? trustedManagedAgentHeads(
        [...metadata.managedHeads],
        metadata.ownerPubkeys,
        provisionedEmployeePubkeys,
      )
    : [];
  for (const head of trustedHeads) {
    if (head.provisioned && head.roleId) add(head.roleId, head.pubkey);
  }
  return byHandle;
}

/**
 * Reconcile a missing mention only when relay metadata proves it is one of the
 * bundled Website employees. Metadata is refreshed whenever the cached role
 * map is partial, so a stale subset cannot let a known provisioned mention
 * bypass adoption. Ordinary remote and human mentions remain untouched when
 * the relay metadata cannot prove a Website identity.
 */
export async function reconcileProvisionedMentionedAgents({
  mentionPubkeys,
  managedAgentsByPubkey,
  preparedManagedAgents,
  getCachedMetadata,
  refreshMetadata,
  refreshManagedAgents,
  adopt = adoptProvisionedEmployees,
  scopeStillCurrent,
}: ProvisionedMentionReconciliationInput): Promise<string | null> {
  const missingMentionedPubkeys = [...new Set(mentionPubkeys.map(normalizePubkey))]
    .filter((pubkey) => !managedAgentsByPubkey.has(pubkey));
  if (missingMentionedPubkeys.length === 0) return null;
  if (!scopeStillCurrent()) {
    return "The community changed while preparing the mentioned teammate. Refresh and try again.";
  }

  let metadata = getCachedMetadata();
  let websitePubkeysByHandle = provisionedWebsitePubkeysByHandle(metadata);
  // A partial cache is not evidence that the missing mention is ordinary.
  // Refresh until all bundled Website roles are accounted for. If that read is
  // unavailable, retain any cached role identity already proven by the relay;
  // only mentions absent from that trusted subset may use the normal path.
  if (websitePubkeysByHandle.size < PROVISIONED_WEBSITE_HANDLES.size) {
    try {
      metadata = await refreshMetadata();
      if (!scopeStillCurrent()) {
        return "The community changed while preparing the mentioned teammate. Refresh and try again.";
      }
      websitePubkeysByHandle = provisionedWebsitePubkeysByHandle(metadata);
    } catch {
      // A partial refresh must not erase a cached Avery/Ren/Jules/Vera proof.
      // The later intersection keeps unrelated remote mentions untouched.
    }
  }

  const websitePubkeys = new Set(websitePubkeysByHandle.values());
  const missingProvisionedPubkeys = missingMentionedPubkeys.filter((pubkey) =>
    websitePubkeys.has(pubkey),
  );
  if (missingProvisionedPubkeys.length === 0) return null;

  let outcomes: ProvisionedAdoption[];
  try {
    outcomes = await adopt();
    if (!scopeStillCurrent()) {
      return "The community changed while preparing the mentioned teammate. Refresh and try again.";
    }
    for (const agent of await refreshManagedAgents()) {
      managedAgentsByPubkey.set(normalizePubkey(agent.pubkey), agent);
    }
    for (const agent of preparedManagedAgents) {
      managedAgentsByPubkey.set(normalizePubkey(agent.pubkey), agent);
    }
  } catch (error) {
    return `Managed teammate setup is still in progress. ${errorMessage(
      error,
      "Retry after the Website Manager team finishes installing.",
    )}`;
  }

  const stillMissing = missingProvisionedPubkeys.filter(
    (pubkey) => !managedAgentsByPubkey.has(pubkey),
  );
  if (stillMissing.length === 0) return null;

  const websiteOutcome = outcomes.find((outcome) => {
    const handle = outcome.handle.trim().toLowerCase();
    if (!PROVISIONED_WEBSITE_HANDLES.has(handle)) return false;
    const outcomePubkey =
      "pubkey" in outcome && HEX_64.test(normalizePubkey(outcome.pubkey))
        ? normalizePubkey(outcome.pubkey)
        : websitePubkeysByHandle.get(handle);
    return outcomePubkey !== undefined && stillMissing.includes(outcomePubkey);
  });
  const blockedPubkey = stillMissing[0];
  const blockedHandle =
    websiteOutcome?.handle.trim() ||
    [...websitePubkeysByHandle.entries()].find(
      ([, pubkey]) => pubkey === blockedPubkey,
    )?.[0] ||
    "Website teammate";
  const reason =
    websiteOutcome && "reason" in websiteOutcome
      ? `: ${websiteOutcome.reason}`
      : "";
  return `${blockedHandle} could not be prepared${reason}. Retry in a moment.`;
}
