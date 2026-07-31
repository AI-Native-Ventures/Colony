import { resolveTeamPersonas } from "@/features/agents/lib/teamPersonas";
import type { AgentPersona, AgentTeam, ChannelRole } from "@/shared/api/types";
import { truncatePubkey } from "@/shared/lib/pubkey";

export type TeamMentionMember = {
  displayName: string;
  kind: "identity" | "persona";
  personaId?: string;
  pubkey?: string;
};

export type MentionKind = "identity" | "persona" | "team" | "block";

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
};

export type BlockMentionCandidate = {
  kind: "block";
  blockHandle: string;
  blockAddress: string;
  manifestId: string;
  displayName: string;
};

export type MentionCandidate = ActorMentionCandidate | BlockMentionCandidate;

export type BlockCatalogMentionSource = {
  handle: string;
  name: string;
  blockAddress: string;
  manifestId: string;
  status: "active" | "deprecated";
};

const BLOCK_HANDLE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const LOWER_HEX_64_RE = /^[0-9a-f]{64}$/;

export function mentionCandidateLabel(candidate: MentionCandidate) {
  if (candidate.kind === "block") {
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

    const teamMembers = resolution.resolvedPersonas
      .map((persona) => findTeamMemberTarget(persona, candidates))
      .filter((member): member is TeamMentionMember => member !== null);
    if (teamMembers.length !== resolution.resolvedPersonas.length) return [];

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
