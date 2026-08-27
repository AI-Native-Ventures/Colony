import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";

export type MentionCandidateForRanking =
  | {
      displayName: string | null;
      isAgent: boolean;
      isMember: boolean;
      kind: "identity" | "persona" | "team";
      personaId?: string | null;
      personaName?: string | null;
      pubkey?: string;
      /** Stable lowercase role slug, e.g. `cto`. Never displayed. */
      roleId?: string | null;
      /** Human role title, e.g. `CTO`. Inserted when a role alias wins. */
      roleTitle?: string | null;
      secondaryLabel?: string | null;
    }
  | {
      blockHandle: string;
      displayName: string;
      kind: "block";
    }
  | {
      cohortId: string;
      displayName: string;
      kind: "cohort";
    }
  | {
      displayName: string;
      /** Stable mention ID: a UUID, taxonomy ID, or industry/vertical pair. */
      discoveryKind: string;
      entityId: string;
      kind: "discovery";
    };

export type RankedMentionCandidate<T extends MentionCandidateForRanking> = {
  candidate: T;
  groupRank: number;
  /**
   * The text the editor inserts and keys its authoritative mention maps by.
   * A role alias win makes this the role title, so the visible `@CTO` and the
   * stored pubkey reference can never disagree.
   */
  label: string;
  /** The label this candidate would carry with no role alias involved. */
  personalLabel: string;
  /**
   * True when a role ID/title alias produced the winning score AND that role
   * title uniquely identifies this candidate among the ranked results.
   */
  matchedRole: boolean;
  order: number;
  score: number;
};

function getMentionCandidateGroupRank(
  candidate: MentionCandidateForRanking,
  activePersonaIds: ReadonlySet<string>,
) {
  if (candidate.kind === "block" || candidate.kind === "cohort") return 2;
  // Discovery rows come after every actor group: typing "@c" must keep
  // offering charlie the agent ahead of "Charitable Foundations" the
  // vertical, whatever membership state that agent is in.
  if (candidate.kind === "discovery") return 4;
  if (candidate.isMember) return 0;

  const isRunnablePersona =
    candidate.kind === "team" ||
    candidate.kind === "persona" ||
    (candidate.personaId ? activePersonaIds.has(candidate.personaId) : false);
  if (isRunnablePersona) return 1;

  if (!candidate.isAgent) return 2;

  return 3;
}

/** True for actor candidates (identity/persona/team) — the only variants
 * carrying a pubkey, role, or persona-name field. Block and cohort
 * candidates are reference-only entities and never match here. */
/** True for actor candidates (identity/persona/team) — the only variants
 * carrying a pubkey, role, or persona-name field. Reference-only entity
 * candidates (block, cohort, discovery) never match here. */
function isActorCandidate(
  candidate: MentionCandidateForRanking,
): candidate is Extract<
  MentionCandidateForRanking,
  { kind: "identity" | "persona" | "team" }
> {
  return (
    candidate.kind !== "block" &&
    candidate.kind !== "cohort" &&
    candidate.kind !== "discovery"
  );
}

function scoreMentionCandidateLabel(
  label: string,
  lowerQuery: string,
): number | null {
  const lower = label.toLowerCase();
  if (lower === lowerQuery) return 0;
  if (lower.startsWith(lowerQuery)) return 1;

  const words = lower.split(/[\s\-_]+/).filter(Boolean);
  if (words.some((word) => word === lowerQuery)) return 2;
  if (words.some((word) => word.startsWith(lowerQuery))) return 3;

  return null;
}

export function rankMentionCandidates<T extends MentionCandidateForRanking>(
  candidates: readonly T[],
  query: string,
  activePersonaIds: ReadonlySet<string> = new Set(),
): RankedMentionCandidate<T>[] {
  const lowerQuery = query.toLowerCase();

  const ranked = candidates
    .map((candidate, order) => {
      const pubkeyLower =
        isActorCandidate(candidate) && candidate.pubkey
          ? normalizePubkey(candidate.pubkey)
          : "";
      const label =
        candidate.displayName ??
        (isActorCandidate(candidate) && candidate.pubkey
          ? truncatePubkey(candidate.pubkey)
          : "agent");
      const groupRank = getMentionCandidateGroupRank(
        candidate,
        activePersonaIds,
      );

      const roleId = isActorCandidate(candidate) ? candidate.roleId : null;
      const roleTitle = isActorCandidate(candidate)
        ? candidate.roleTitle
        : null;

      const personalScores = [
        candidate.displayName,
        candidate.kind === "block"
          ? candidate.blockHandle
          : isActorCandidate(candidate)
            ? candidate.personaName
            : null,
        isActorCandidate(candidate) ? candidate.secondaryLabel : null,
      ]
        .map((value) =>
          value ? scoreMentionCandidateLabel(value, lowerQuery) : null,
        )
        .filter((score): score is number => score !== null);
      const personalScore =
        personalScores.length > 0 ? Math.min(...personalScores) : null;

      const roleScores = [roleId, roleTitle]
        .map((value) =>
          value ? scoreMentionCandidateLabel(value, lowerQuery) : null,
        )
        .filter((score): score is number => score !== null);
      const roleScore = roleScores.length > 0 ? Math.min(...roleScores) : null;

      // Ties go to the personal name: it is the identity the user chose, and a
      // role alias should only take over the inserted token when it is the
      // strictly better match for what was typed. A blank title has nothing to
      // insert, so it can never be the winning alias.
      // Trimmed, because this string becomes both the inserted token and the
      // mention-map key. A padded title would insert "@  CTO  " while a draft
      // round-trip trims the key, dropping the reference.
      const insertableRoleTitle = roleTitle?.trim() || null;
      const matchedRole =
        roleScore !== null &&
        insertableRoleTitle !== null &&
        (personalScore === null || roleScore < personalScore);
      const labelScore =
        personalScore !== null && roleScore !== null
          ? Math.min(personalScore, roleScore)
          : (personalScore ?? roleScore);

      const pubkeyScore =
        isActorCandidate(candidate) && candidate.pubkey
          ? pubkeyLower.startsWith(lowerQuery)
            ? 4
            : pubkeyLower.includes(lowerQuery)
              ? 5
              : null
          : null;
      const score = labelScore !== null ? labelScore : pubkeyScore;

      return {
        candidate,
        groupRank,
        label: matchedRole ? (insertableRoleTitle as string) : label,
        personalLabel: label,
        matchedRole,
        order,
        score,
      };
    })
    .filter((item): item is RankedMentionCandidate<T> => item.score !== null)
    .sort(
      (a, b) =>
        a.groupRank - b.groupRank || a.score - b.score || a.order - b.order,
    );

  return resolveCollidingRoleLabels(ranked);
}

/**
 * Stop a shared role title from collapsing two targets onto one mention token.
 *
 * Nothing stops two personas holding the same role, and the draft's mention
 * maps are keyed by the visible token. Two rows both labelled `CTO` would let
 * a draft read `@CTO @CTO` while only one pubkey survived in the map — one
 * target silently lost on send, which is the exact failure this feature exists
 * to prevent. A role title is only worth inserting when it identifies exactly
 * one candidate, so a colliding role match reverts to its personal name.
 *
 * Colliding *personal* names are left alone: that collision predates roles, and
 * the picker already discloses it by showing each candidate's npub.
 */
function resolveCollidingRoleLabels<T extends MentionCandidateForRanking>(
  ranked: RankedMentionCandidate<T>[],
): RankedMentionCandidate<T>[] {
  const labelCounts = new Map<string, number>();
  for (const item of ranked) {
    const key = item.label.toLowerCase();
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }

  return ranked.map((item) => {
    if (!item.matchedRole) return item;
    if ((labelCounts.get(item.label.toLowerCase()) ?? 0) <= 1) return item;
    return { ...item, label: item.personalLabel, matchedRole: false };
  });
}
