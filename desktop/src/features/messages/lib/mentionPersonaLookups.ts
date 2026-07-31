/**
 * Persona-derived lookups used to build mention candidates.
 *
 * A deployed agent carries its own personal name; its persona name and its
 * stable role identity live on the linked Persona. These joins are what let
 * `@jason` and `@cto` resolve to the same pubkey without either alias becoming
 * the authoritative target.
 *
 * Extracted from `useMentions` as pure functions so the hook stays under the
 * file-size ratchet and the joins are directly testable.
 */
import type { AgentPersona, ManagedAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

/** A persona's stable role identity. Both halves are required or neither is. */
export type PersonaRole = {
  roleId: string;
  roleTitle: string;
};

/** Map each deployed agent's pubkey to its linked Persona's display name. */
export function buildPersonaNameByPubkey(
  agents: readonly ManagedAgent[] | undefined,
  personas: readonly AgentPersona[] | undefined,
): Map<string, string> {
  const personaById = new Map(
    (personas ?? []).map((persona) => [persona.id, persona.displayName]),
  );
  const lookup = new Map<string, string>();
  for (const agent of agents ?? []) {
    if (!agent.personaId) continue;
    const name = personaById.get(agent.personaId);
    if (name) lookup.set(normalizePubkey(agent.pubkey), name);
  }
  return lookup;
}

/**
 * Map each Persona ID to its role, skipping personas with a half-set pair.
 *
 * A role without a title has nothing to insert, and a title without an ID has
 * no stable identity behind it, so neither is a usable mention alias.
 */
export function buildPersonaRoleById(
  personas: readonly AgentPersona[] | undefined,
): Map<string, PersonaRole> {
  const lookup = new Map<string, PersonaRole>();
  for (const persona of personas ?? []) {
    const roleId = persona.roleId?.trim();
    const roleTitle = persona.roleTitle?.trim();
    if (roleId && roleTitle) lookup.set(persona.id, { roleId, roleTitle });
  }
  return lookup;
}

/** Map each deployed agent's pubkey to its linked Persona's role. */
export function buildPersonaRoleByPubkey(
  agents: readonly ManagedAgent[] | undefined,
  personaRoleById: ReadonlyMap<string, PersonaRole>,
): Map<string, PersonaRole> {
  const lookup = new Map<string, PersonaRole>();
  for (const agent of agents ?? []) {
    const role = agent.personaId
      ? personaRoleById.get(agent.personaId)
      : undefined;
    if (role) lookup.set(normalizePubkey(agent.pubkey), role);
  }
  return lookup;
}
