import { resolveTeamPersonas } from "@/features/agents/lib/teamPersonas";
import type { Cohort } from "@/features/company/contracts";
import type { AgentPersona, AgentTeam, ChannelRole } from "@/shared/api/types";
import { KIND_COHORT } from "@/shared/constants/kinds";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";

export type TeamMentionMember = {
  displayName: string;
  kind: "identity" | "persona";
  personaId?: string;
  pubkey?: string;
};

export type MentionKind = "identity" | "persona" | "team" | "block" | "cohort";

export type ActorMentionCandidate = {
  kind: "identity" | "persona" | "team";
  pubkey?: string;
  personaId?: string;
  teamId?: string;
  teamMembers?: TeamMentionMember[];
  displayName: string | null;
  avatarUrl?: string | null;
  isMember: boolean;
  role?: ChannelRole | null;
  personaName?: string | null;
  secondaryLabel?: string | null;
  ownerPubkey?: string | null;
  isAgent: boolean;
  isManagedAgent?: boolean;
  isGlobalSearchResult?: boolean;
  /**
   * Stable lowercase role slug joined from the linked Persona. Matching is
   * alias-only: the authoritative target stays the pubkey or Persona ID.
   */
  roleId?: string | null;
  /** Human role title paired with `roleId`; inserted when the role wins. */
  roleTitle?: string | null;
};

export type BlockMentionCandidate = {
  kind: "block";
  blockHandle: string;
  blockAddress: string;
  manifestId: string;
  displayName: string;
};

export type CohortMentionCandidate = {
  kind: "cohort";
  cohortId: string;
  cohortAddress: string;
  displayName: string;
};

export type MentionCandidate =
  | ActorMentionCandidate
  | BlockMentionCandidate
  | CohortMentionCandidate;

export type BlockCatalogMentionSource = {
  handle: string;
  name: string;
  blockAddress: string;
  manifestId: string;
  status: "active" | "deprecated";
};

const BLOCK_HANDLE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const LOWER_HEX_64_RE = /^[0-9a-f]{64}$/;
// Mirrors buzz-core's generic `validate_id` charset (see draftMentionRefs.ts).
const COHORT_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export function mentionCandidateLabel(candidate: MentionCandidate) {
  if (candidate.kind === "block" || candidate.kind === "cohort") {
    return candidate.displayName;
  }
  return (
    candidate.displayName ??
    (candidate.pubkey ? truncatePubkey(candidate.pubkey) : "agent")
  );
}

export function globalSearchIdentityKey(candidate: MentionCandidate) {
  if (
    candidate.kind === "block" ||
    candidate.kind === "cohort" ||
    !candidate.isGlobalSearchResult ||
    candidate.isMember ||
    candidate.isAgent
  ) {
    return null;
  }

  const label = candidate.displayName?.trim().toLowerCase();
  if (!label) return null;

  const secondaryLabel = candidate.secondaryLabel?.trim().toLowerCase() ?? "";
  return `global-person:${label}:${secondaryLabel}`;
}

/** Build strict, deduplicated Block entries from active catalog projections. */
export function buildBlockMentionCandidates(
  sources: readonly BlockCatalogMentionSource[],
): BlockMentionCandidate[] {
  const byAddress = new Map<string, BlockMentionCandidate>();
  for (const source of sources) {
    if (source.status !== "active") continue;
    const blockHandle = source.handle.trim().toLowerCase();
    const displayName = source.name.trim();
    const blockAddress = source.blockAddress.trim();
    const manifestId = source.manifestId.trim();
    const coordinate = blockAddress.split(":");
    if (
      !BLOCK_HANDLE_RE.test(blockHandle) ||
      !displayName ||
      coordinate.length !== 3 ||
      coordinate[0] !== "30178" ||
      !LOWER_HEX_64_RE.test(coordinate[1] ?? "") ||
      coordinate[2] !== blockHandle ||
      !LOWER_HEX_64_RE.test(manifestId)
    ) {
      continue;
    }
    byAddress.set(blockAddress, {
      kind: "block",
      blockHandle,
      blockAddress,
      manifestId,
      displayName,
    });
  }
  return [...byAddress.values()];
}

/**
 * Build strict, deduplicated Cohort entries from a company's cohort list.
 *
 * Unlike a block handle, a cohort's display text (`name`) is not baked into
 * its `d` tag, so there is no third-segment-equals-name check here — only
 * the coordinate's own shape and the relay-self pubkey are validated.
 */
export function buildCohortMentionCandidates(
  cohorts: readonly Cohort[],
  relaySelfPubkey: string,
): CohortMentionCandidate[] {
  const normalizedRelaySelf = relaySelfPubkey.trim().toLowerCase();
  if (!LOWER_HEX_64_RE.test(normalizedRelaySelf)) {
    return [];
  }
  const byAddress = new Map<string, CohortMentionCandidate>();
  for (const cohort of cohorts) {
    const cohortId = cohort.id.trim();
    const displayName = cohort.name.trim();
    if (!COHORT_ID_RE.test(cohortId) || !displayName) {
      continue;
    }
    const cohortAddress = `${KIND_COHORT}:${normalizedRelaySelf}:${cohortId}`;
    byAddress.set(cohortAddress, {
      kind: "cohort",
      cohortId,
      cohortAddress,
      displayName,
    });
  }
  return [...byAddress.values()];
}

export function formatCohortMention(displayName: string) {
  return `@${displayName} `;
}

function findTeamMemberTarget(
  persona: AgentPersona,
  candidates: readonly ActorMentionCandidate[],
): TeamMentionMember | null {
  const linked = candidates
    .filter(
      (candidate) =>
        (candidate.kind === "identity" || candidate.kind === "persona") &&
        candidate.personaId === persona.id,
    )
    .sort((left, right) => {
      const rank = (candidate: ActorMentionCandidate) => {
        if (candidate.kind === "identity" && candidate.isMember) return 0;
        if (candidate.kind === "identity" && candidate.isManagedAgent) return 1;
        if (candidate.kind === "identity") return 2;
        return 3;
      };
      return rank(left) - rank(right);
    })[0];

  if (linked) {
    return {
      displayName: linked.displayName?.trim() || persona.displayName,
      kind: linked.kind === "identity" ? "identity" : "persona",
      personaId: linked.personaId,
      pubkey: linked.pubkey,
    };
  }

  return persona.isActive
    ? {
        displayName: persona.displayName,
        kind: "persona",
        personaId: persona.id,
      }
    : null;
}

/** Build autocomplete entries for editable, locally owned teams. */
export function buildTeamMentionCandidates(
  teams: readonly AgentTeam[],
  personas: AgentPersona[],
  candidates: readonly ActorMentionCandidate[],
): ActorMentionCandidate[] {
  return teams.flatMap((team) => {
    if (team.isBuiltin || !team.name.trim()) return [];

    const resolution = resolveTeamPersonas(team, personas);
    if (!resolution.isUsable) return [];

    const resolvedMembers = resolution.resolvedPersonas.map((persona) =>
      findTeamMemberTarget(persona, candidates),
    );
    if (resolvedMembers.some((member) => member === null)) return [];

    // One persona may sit in several teams, and two persona rows may resolve
    // onto the same deployed identity. Expand each distinct target once, in
    // first-seen order, keyed by pubkey and falling back to persona ID.
    const seenTargets = new Set<string>();
    const teamMembers: TeamMentionMember[] = [];
    for (const member of resolvedMembers) {
      if (!member) continue;
      const targetKey = member.pubkey
        ? `pubkey:${normalizePubkey(member.pubkey)}`
        : member.personaId
          ? `persona:${member.personaId}`
          : null;
      // A member with no addressable target cannot be expanded, and silently
      // shipping a short team would under-address the mention. Fail closed,
      // matching every other rejection in this function.
      if (targetKey === null) return [];
      if (seenTargets.has(targetKey)) continue;
      seenTargets.add(targetKey);
      teamMembers.push(member);
    }
    if (teamMembers.length === 0) return [];

    // Two distinct targets sharing one visible mention token would make the
    // text-keyed draft maps ambiguous, so the whole team is withheld.
    const mentionNames = new Set<string>();
    for (const member of teamMembers) {
      const mentionName = member.displayName.trim().toLowerCase();
      if (mentionNames.has(mentionName)) return [];
      mentionNames.add(mentionName);
    }

    return [
      {
        kind: "team" as const,
        teamId: team.id,
        teamMembers,
        displayName: team.name.trim(),
        isMember: false,
        isAgent: true,
      },
    ];
  });
}

export function formatTeamMention(
  teamName: string,
  members: readonly TeamMentionMember[],
) {
  return `${teamName}(${members.map((member) => `@${member.displayName}`).join(" ")}) `;
}

export function formatBlockMention(blockHandle: string) {
  return `@${blockHandle} `;
}

/**
 * Fold a newly seen mention candidate into the one already collected for the
 * same pubkey. One identity legitimately arrives from several sources (channel
 * member, relay directory, managed agent, global search), each knowing
 * different fields, so first-seen wins per field and agent-authored labels
 * take precedence over human-sourced ones.
 *
 * `profile` is that pubkey's published kind-0 summary. It supplies two things
 * no local source can: the owner of another member's agent, and the workspace
 * role — local persona records only describe our own agents, so without the
 * published role another member's instance of a shared role would never merge
 * with ours (docs/design/role-agents.html).
 */
export function mergeMentionCandidate(
  current: ActorMentionCandidate | undefined,
  candidate: ActorMentionCandidate & { pubkey: string },
  profile: { ownerPubkey?: string | null; role?: string | null } | null,
): ActorMentionCandidate {
  const publishedRole = profile?.role ?? null;
  if (!current) {
    return candidate.roleId
      ? candidate
      : { ...candidate, roleId: publishedRole };
  }

  return {
    ...current,
    avatarUrl: current.avatarUrl ?? candidate.avatarUrl ?? null,
    displayName:
      current.isAgent && !candidate.isAgent
        ? current.displayName
        : candidate.isAgent && !current.isAgent
          ? (candidate.displayName ?? current.displayName)
          : (current.displayName ?? candidate.displayName),
    isAgent: current.isAgent || candidate.isAgent,
    isMember: current.isMember || candidate.isMember,
    personaId: current.personaId ?? candidate.personaId,
    personaName: current.personaName ?? candidate.personaName ?? null,
    role: current.role ?? candidate.role ?? null,
    roleId: current.roleId ?? candidate.roleId ?? publishedRole,
    roleTitle: current.roleTitle ?? candidate.roleTitle ?? null,
    secondaryLabel: current.secondaryLabel ?? candidate.secondaryLabel ?? null,
    ownerPubkey:
      current.ownerPubkey ??
      candidate.ownerPubkey ??
      (candidate.isAgent && candidate.pubkey ? profile?.ownerPubkey : null) ??
      null,
    isManagedAgent: current.isManagedAgent || candidate.isManagedAgent,
  };
}
