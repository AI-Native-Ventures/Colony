import type { AgentPersona, ManagedAgent } from "@/shared/api/types";
import {
  buildPersonaRoleById,
  buildPersonaRoleByPubkey,
} from "@/features/messages/lib/mentionPersonaLookups";

/** Display-only job titles; permissions and orchestration rank are separate. */
export function buildAgentRoleTitles(
  agents: readonly ManagedAgent[] | undefined,
  personas: readonly AgentPersona[] | undefined,
): Map<string, string> {
  return new Map(
    [...buildPersonaRoleByPubkey(agents, buildPersonaRoleById(personas))].map(
      ([pubkey, role]) => [pubkey, role.roleTitle],
    ),
  );
}

/** A readable agent marker even when its job title is not available yet. */
export function agentRoleLabel(roleTitle?: string | null): string {
  const title = roleTitle?.trim();
  return title ? `${title} · Agent` : "Agent";
}
