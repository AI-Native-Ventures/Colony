import type { MentionSuggestion } from "@/features/messages/ui/MentionAutocomplete";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { formatOwnerLabel } from "@/features/profile/lib/identity";
import type { ChannelRole, ChannelType } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import type {
  BlockMentionCandidate,
  CohortMentionCandidate,
  DiscoveryMentionCandidate,
  TeamMentionMember,
} from "./mentionCandidates";

type ActorMentionSuggestionCandidate = {
  kind: "identity" | "persona" | "team";
  pubkey?: string;
  personaId?: string | null;
  teamId?: string;
  teamMembers?: TeamMentionMember[];
  avatarUrl?: string | null;
  displayName?: string | null;
  isAgent: boolean;
  isMember: boolean;
  role?: ChannelRole | null;
  roleId?: string | null;
  roleTitle?: string | null;
  ownerPubkey?: string | null;
};

export type MentionSuggestionCandidate =
  | ActorMentionSuggestionCandidate
  | BlockMentionCandidate
  | CohortMentionCandidate
  | DiscoveryMentionCandidate;

export function mapMentionCandidateToSuggestion(opts: {
  candidate: MentionSuggestionCandidate;
  label: string;
  /** True when a role alias produced `label`; drives the alias hint shown. */
  matchedRole?: boolean;
  channelType?: ChannelType | null;
  currentPubkey?: string | null;
  ownerProfiles?: UserProfileLookup;
  profiles?: UserProfileLookup;
}): MentionSuggestion {
  const {
    candidate,
    channelType,
    currentPubkey,
    label,
    matchedRole,
    ownerProfiles,
    profiles,
  } = opts;
  if (candidate.kind === "block") {
    return {
      kind: "block",
      blockHandle: candidate.blockHandle,
      blockAddress: candidate.blockAddress,
      manifestId: candidate.manifestId,
      displayName: candidate.displayName,
    };
  }

  if (candidate.kind === "cohort") {
    return {
      kind: "cohort",
      cohortId: candidate.cohortId,
      cohortAddress: candidate.cohortAddress,
      displayName: candidate.displayName,
    };
  }

  if (candidate.kind === "discovery") {
    return {
      kind: "discovery",
      discoveryKind: candidate.discoveryKind,
      entityId: candidate.entityId,
      contextId: candidate.contextId,
      detail: candidate.detail,
      displayName: candidate.displayName,
    };
  }

  const ownerLabel = candidate.isAgent
    ? formatOwnerLabel(candidate.ownerPubkey, currentPubkey, ownerProfiles)
    : null;

  // Always surface the alias that is *not* being inserted, so a name/role
  // collision can never be resolved by the visible token alone.
  const personalName = candidate.displayName?.trim() || null;
  const roleTitle = candidate.roleTitle?.trim() || null;
  const aliasLabel = matchedRole ? personalName : roleTitle;

  return {
    pubkey: candidate.pubkey,
    personaId: candidate.personaId ?? undefined,
    teamId: candidate.teamId,
    teamMembers: candidate.teamMembers,
    kind: candidate.kind,
    displayName: label,
    aliasLabel: aliasLabel && aliasLabel !== label ? aliasLabel : null,
    personalName,
    roleTitle,
    avatarUrl:
      candidate.avatarUrl ??
      (candidate.pubkey
        ? profiles?.[normalizePubkey(candidate.pubkey)]?.avatarUrl
        : null) ??
      null,
    isAgent: candidate.isAgent,
    notInChannel:
      candidate.kind !== "team" &&
      channelType !== "dm" &&
      candidate.isMember === false,
    ownerLabel,
    role: !candidate.isAgent && candidate.role === "admin" ? "admin" : null,
  };
}
