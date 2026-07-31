import type { AgentPersona, AgentTeam } from "@/shared/api/types";

type TeamMembershipInput = Pick<AgentTeam, "personaIds"> & {
  leadPersonaId?: string | null;
};

/** Mirror the native per-team shape guard for immediate client feedback. */
export function validateTeamMembership(input: TeamMembershipInput): void {
  const unique = new Set<string>();
  for (const personaId of input.personaIds) {
    if (unique.has(personaId)) {
      throw new Error(`agent ${personaId} can only appear once in a team`);
    }
    unique.add(personaId);
  }

  if (
    input.leadPersonaId !== undefined &&
    input.leadPersonaId !== null &&
    !unique.has(input.leadPersonaId)
  ) {
    throw new Error("Team lead must also be a member of the team.");
  }
}

/**
 * Resolve the lead a membership-only edit should submit.
 *
 * An existing lead is carried through untouched. Removing that agent from the
 * team vacates the role instead of resubmitting a lead who is no longer a
 * member — that would fail the native member/lead invariant with no way to
 * recover from an editor that has no lead picker.
 */
export function resolveSubmittedTeamLead(
  currentLeadPersonaId: string | null | undefined,
  personaIds: readonly string[],
): string | null {
  if (!currentLeadPersonaId) return null;
  return personaIds.includes(currentLeadPersonaId)
    ? currentLeadPersonaId
    : null;
}

export type ResolvedTeamPersonas = {
  hasMissingPersonas: boolean;
  isComplete: boolean;
  isUsable: boolean;
  missingPersonaCount: number;
  missingPersonaIds: string[];
  resolvedPersonaIds: string[];
  resolvedPersonas: AgentPersona[];
};

export function emptyResolvedTeamPersonas(): ResolvedTeamPersonas {
  return {
    hasMissingPersonas: false,
    isComplete: true,
    isUsable: false,
    missingPersonaCount: 0,
    missingPersonaIds: [],
    resolvedPersonaIds: [],
    resolvedPersonas: [],
  };
}

export function isResolvedTeamUsable(
  resolution: Pick<ResolvedTeamPersonas, "isComplete" | "resolvedPersonaIds">,
) {
  return resolution.isComplete && resolution.resolvedPersonaIds.length > 0;
}

export function getUsableTeams(
  teams: readonly AgentTeam[],
  personas: AgentPersona[],
) {
  return teams.filter((team) =>
    isResolvedTeamUsable(resolveTeamPersonas(team, personas)),
  );
}

export function resolveTeamPersonas(
  team: Pick<AgentTeam, "personaIds">,
  personas: AgentPersona[],
): ResolvedTeamPersonas {
  const personasById = new Map(
    personas.map((persona) => [persona.id, persona]),
  );
  const resolvedPersonas: AgentPersona[] = [];
  const resolvedPersonaIds: string[] = [];
  const missingPersonaIds: string[] = [];

  for (const personaId of team.personaIds) {
    const persona = personasById.get(personaId);

    if (persona) {
      resolvedPersonas.push(persona);
      resolvedPersonaIds.push(persona.id);
      continue;
    }

    missingPersonaIds.push(personaId);
  }

  const missingPersonaCount = missingPersonaIds.length;

  return {
    hasMissingPersonas: missingPersonaCount > 0,
    isComplete: missingPersonaCount === 0,
    isUsable: missingPersonaCount === 0 && resolvedPersonaIds.length > 0,
    missingPersonaCount,
    missingPersonaIds,
    resolvedPersonaIds,
    resolvedPersonas,
  };
}
