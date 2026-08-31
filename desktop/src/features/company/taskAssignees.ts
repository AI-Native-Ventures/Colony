/**
 * Who a hand-created Task can be given to.
 *
 * `plan_user_task` rejects an assignee that belongs to no team it was handed
 * (`crates/buzz-sdk/src/implicit_task.rs`), so offering every persona would
 * offer choices the relay refuses. Team membership is the filter, applied
 * here rather than in the dialog so it is directly testable.
 */
import type { AgentPersona, AgentTeam, ManagedAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

export type AssigneeOption = {
  /** Stable persona identity, what `assignee_persona_ids` carries. */
  personaId: string;
  /** Display name for the picker. */
  label: string;
  /**
   * Deployed agent pubkey for this persona, when one exists. `null` means the
   * persona is defined but has no running agent behind it, so a kickoff
   * message has nobody to mention and the task simply waits.
   */
  pubkey: string | null;
};

/** Every persona id that belongs to at least one team. */
export function teamPersonaIds(
  teams: readonly AgentTeam[] | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const team of teams ?? []) {
    for (const personaId of team.personaIds) ids.add(personaId);
    if (team.leadPersonaId) ids.add(team.leadPersonaId);
  }
  return ids;
}

/**
 * Assignable personas, sorted by label so the picker's order is stable
 * between renders rather than following whatever order the queries resolved
 * in.
 */
export function buildAssigneeOptions(
  personas: readonly AgentPersona[] | undefined,
  teams: readonly AgentTeam[] | undefined,
  agents: readonly ManagedAgent[] | undefined,
): AssigneeOption[] {
  const assignable = teamPersonaIds(teams);
  const pubkeyByPersonaId = new Map<string, string>();
  for (const agent of agents ?? []) {
    if (!agent.personaId) continue;
    // First agent wins: two agents on one persona is a configuration the
    // roster allows, and either is an equally correct mention target.
    if (!pubkeyByPersonaId.has(agent.personaId)) {
      pubkeyByPersonaId.set(agent.personaId, normalizePubkey(agent.pubkey));
    }
  }

  return (personas ?? [])
    .filter((persona) => assignable.has(persona.id))
    .map((persona) => ({
      personaId: persona.id,
      label: persona.roleTitle
        ? `${persona.displayName} · ${persona.roleTitle}`
        : persona.displayName,
      pubkey: pubkeyByPersonaId.get(persona.id) ?? null,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * The kickoff message that wakes an assignee, or `null` when nobody can be
 * mentioned.
 *
 * An agent only acts on a turn it was mentioned in, so a task assigned to a
 * persona with no deployed agent produces no message at all rather than one
 * that reads like a request and reaches nobody.
 */
export function buildKickoffMessage(
  title: string,
  assignee: AssigneeOption,
  watchers: readonly AssigneeOption[],
): { content: string; mentionPubkeys: string[] } | null {
  if (!assignee.pubkey) return null;
  const assigneeName = assignee.label.split(" · ")[0] ?? assignee.label;
  const watcherPubkeys = watchers
    .map((watcher) => watcher.pubkey)
    .filter((pubkey): pubkey is string => Boolean(pubkey))
    .filter((pubkey) => pubkey !== assignee.pubkey);
  return {
    content: `@${assigneeName} ${title}`,
    mentionPubkeys: [assignee.pubkey, ...watcherPubkeys],
  };
}
