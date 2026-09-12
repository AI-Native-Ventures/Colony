/**
 * Pure presentation and safety logic for the Website Manager installer.
 *
 * Kept free of runtime imports (type-only from the API module) so it runs
 * under `node --test`, and so the "no optimistic success" rules are pinned:
 * the UI claims an install only from the native result's real publication and
 * skill statuses, never from the click.
 */

import type {
  InstallWebsiteTeamResult,
  InstalledWebsiteSkill,
  PublicationStatus,
  WebsiteTeamRecipe,
} from "@/shared/api/tauriWebsiteTeam";

export type InstallState = "complete" | "pending_publish" | "incomplete";

export type PersonaInstallRow = {
  personaId: string;
  displayName: string;
  roleTitle: string;
  tier: string;
  colorIndex: number;
  status: "installed" | "existing" | "missing";
  agentPubkey: string;
  assignedSkills: string[];
};

export type InstallAssessment = {
  state: InstallState;
  headline: string;
  detail: string | null;
  personas: PersonaInstallRow[];
  pendingPublications: number;
  failedSkills: InstalledWebsiteSkill[];
  preservedSkills: InstalledWebsiteSkill[];
  reconciled: boolean;
  upgraded: boolean;
  upgradedFrom: string | null;
};

const EXPECTED_WEBSITE_PERSONAS = [
  { slug: "avery", personaId: "website-manager-avery", roleId: "website-manager" },
  {
    slug: "ren",
    personaId: "website-manager-ren",
    roleId: "website-researcher",
  },
  {
    slug: "jules",
    personaId: "website-manager-jules",
    roleId: "website-designer-builder",
  },
  {
    slug: "vera",
    personaId: "website-manager-vera",
    roleId: "website-reviewer",
  },
] as const;

/** Relay comparison mirroring the native canonicalization well enough for the
 *  UI: surrounding space and trailing slashes never mean a different server. */
export function normalizeRelay(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/** Whether the community that was installed into is still the active one. */
export function isInstallCommunityActive(
  activeRelayUrl: string,
  result: Pick<InstallWebsiteTeamResult, "relayUrl">,
): boolean {
  return normalizeRelay(activeRelayUrl) === normalizeRelay(result.relayUrl);
}

export function describePublication(
  status: PublicationStatus | string,
): string {
  switch (status) {
    case "published":
      return "Published to this community";
    case "queued":
      return "Queued; retries automatically";
    default:
      return "Not queued yet";
  }
}

function publicationStatuses(result: InstallWebsiteTeamResult): string[] {
  return [
    result.publication.team,
    ...result.publication.personas.map((entry) => entry.status),
    ...result.publication.agents.map((entry) => entry.status),
  ];
}

/** Reject a result that cannot prove it represents this exact bundled team. */
function websiteInstallIntegrityError(
  result: InstallWebsiteTeamResult,
): string | null {
  const expectedById = new Map<string, (typeof EXPECTED_WEBSITE_PERSONAS)[number]>(
    EXPECTED_WEBSITE_PERSONAS.map((persona) => [persona.personaId, persona]),
  );
  const personaIds = new Set<string>();
  const agentPubkeys = new Set<string>();
  if (result.personas.length !== EXPECTED_WEBSITE_PERSONAS.length) {
    return "The install did not return all four bundled Website teammates.";
  }
  for (const persona of result.personas) {
    const expected = expectedById.get(persona.personaId);
    const pubkey = persona.agentPubkey.trim().toLowerCase();
    if (
      !expected ||
      personaIds.has(persona.personaId) ||
      persona.slug !== expected.slug ||
      persona.roleId !== expected.roleId ||
      !/^[0-9a-f]{64}$/.test(pubkey) ||
      agentPubkeys.has(pubkey)
    ) {
      return "The install returned an unexpected or duplicate Website teammate.";
    }
    personaIds.add(persona.personaId);
    agentPubkeys.add(pubkey);
  }
  if (personaIds.size !== expectedById.size) {
    return "The install did not return all four bundled Website roles.";
  }

  const publishedPersonaIds = new Set<string>();
  if (result.publication.personas.length !== expectedById.size) {
    return "The four Website persona publications could not be matched.";
  }
  for (const entry of result.publication.personas) {
    if (!expectedById.has(entry.id) || publishedPersonaIds.has(entry.id)) {
      return "The four Website persona publications could not be matched.";
    }
    publishedPersonaIds.add(entry.id);
  }
  const publishedAgentPubkeys = new Set<string>();
  if (result.publication.agents.length !== agentPubkeys.size) {
    return "The four Website agent publications could not be matched.";
  }
  for (const entry of result.publication.agents) {
    const pubkey = entry.id.trim().toLowerCase();
    if (
      !agentPubkeys.has(pubkey) ||
      publishedAgentPubkeys.has(pubkey)
    ) {
      return "The four Website agent publications could not be matched.";
    }
    publishedAgentPubkeys.add(pubkey);
  }
  return null;
}

/**
 * Assess the native install result. `complete` requires every persona agent
 * present and every head published; queued heads are `pending_publish`, and a
 * failed skill write is `incomplete` because the runtime would not actually
 * have the runbook.
 */
export function assessInstall(
  result: InstallWebsiteTeamResult,
): InstallAssessment {
  const personas: PersonaInstallRow[] = result.personas.map((persona) => ({
    personaId: persona.personaId,
    displayName: persona.displayName,
    roleTitle: persona.roleTitle,
    tier: persona.tier,
    colorIndex: persona.colorIndex,
    status: persona.agentPubkey
      ? persona.created
        ? "installed"
        : "existing"
      : "missing",
    agentPubkey: persona.agentPubkey,
    assignedSkills: persona.assignedSkills,
  }));
  const missingAgents = personas.filter(
    (row) => row.status === "missing",
  ).length;
  const failedSkills = result.skills.filter(
    (skill) => skill.status === "failed",
  );
  const preservedSkills = result.skills.filter(
    (skill) => skill.status === "preserved",
  );
  const pendingPublications = publicationStatuses(result).filter(
    (status) => status !== "published",
  ).length;
  const integrityError = websiteInstallIntegrityError(result);

  if (integrityError || missingAgents > 0 || failedSkills.length > 0) {
    const reasons: string[] = [];
    if (integrityError) {
      reasons.push(integrityError);
    }
    if (missingAgents > 0) {
      reasons.push(
        `${missingAgents} of the four agents are missing`,
      );
    }
    if (failedSkills.length > 0) {
      reasons.push(
        `${failedSkills.length} skill${failedSkills.length === 1 ? "" : "s"} could not be written`,
      );
    }
    return {
      state: "incomplete",
      headline: "Installation needs attention",
      detail: `${reasons.join("; ")}. Retry, or fix the record it names and retry.`,
      personas,
      pendingPublications,
      failedSkills,
      preservedSkills,
      reconciled: result.reconciled,
      upgraded: result.upgraded,
      upgradedFrom: result.upgradedFrom,
    };
  }

  if (pendingPublications > 0) {
    return {
      state: "pending_publish",
      headline: "Team installed; publishing is still catching up",
      detail:
        result.publication.detail ??
        "Some team heads are queued and will publish automatically on the next sync.",
      personas,
      pendingPublications,
      failedSkills,
      preservedSkills,
      reconciled: result.reconciled,
      upgraded: result.upgraded,
      upgradedFrom: result.upgradedFrom,
    };
  }

  return {
    state: "complete",
    headline: result.upgraded
      ? `Updated to ${result.recipeVersion}`
      : result.reconciled
        ? "Website Manager team is already installed"
        : "Website Manager team is installed",
    detail: result.upgraded
      ? result.upgradedFrom
        ? `Provided content updated from ${result.upgradedFrom} to ${result.recipeVersion}. Your model, provider, runtime, channels, and worktrees are unchanged.`
        : `Provided content updated to ${result.recipeVersion}. Your model, provider, runtime, channels, and worktrees are unchanged.`
      : "Editable in Agents. Avery leads; Ren, Jules, and Vera report to her.",
    personas,
    pendingPublications: 0,
    failedSkills,
    preservedSkills,
    reconciled: result.reconciled,
    upgraded: result.upgraded,
    upgradedFrom: result.upgradedFrom,
  };
}

export type AgentStartOutcome = {
  personaId: string;
  displayName: string;
  pubkey: string;
  /** Whether the agent is confirmed in the channel, including a retry. */
  joined: boolean;
  /** Whether this attempt added the agent to the channel. */
  newlyAdded: boolean;
  /** Whether the runtime reached the boundary required by Website actions. */
  ready: boolean;
  /** @deprecated Use `newlyAdded`; retained for persisted/older callers. */
  membershipAdded?: boolean;
  /** Whether a start/deploy call was made during this attempt. */
  started: boolean;
  error: string | null;
  needsConfiguration: boolean;
};

export type AgentStartSummary = {
  started: number;
  joined: number;
  newlyAdded: number;
  ready: number;
  needsConfiguration: number;
  failed: AgentStartOutcome[];
};

export function looksLikeConfigurationError(message: string): boolean {
  return /not ready|readiness|credential|provider|model|sign[- ]?in|log[- ]?in|install(ed)?|power|subscription|credit|api key|missing/i.test(
    message,
  );
}

export function summarizeAgentStarts(
  outcomes: readonly AgentStartOutcome[],
): AgentStartSummary {
  const failed = outcomes.filter((outcome) => !outcome.ready);
  return {
    started: outcomes.filter((outcome) => outcome.started).length,
    joined: outcomes.filter((outcome) => outcome.joined).length,
    newlyAdded: outcomes.filter((outcome) => outcome.newlyAdded).length,
    ready: outcomes.filter((outcome) => outcome.ready).length,
    needsConfiguration: failed.filter((outcome) => outcome.needsConfiguration)
      .length,
    failed,
  };
}

/** The starter prompt to hand to the job surface: the user's, else the recipe
 *  example. The seed URL is carried separately in the install result. */
export function starterPromptFor(
  result: Pick<InstallWebsiteTeamResult, "starterPrompt">,
  recipe: Pick<WebsiteTeamRecipe, "examplePrompt">,
): string {
  return result.starterPrompt?.trim() || recipe.examplePrompt;
}

/** Build the editable first brief placed into the selected channel's draft. */
export function buildWebsiteStarterDraft(prompt: string, seedUrl: string): string {
  const trimmedPrompt = prompt.trim() || "Improve my website";
  const addressedPrompt = /^@avery\b/i.test(trimmedPrompt)
    ? trimmedPrompt
    : `@Avery ${trimmedPrompt}`;
  const trimmedUrl = seedUrl.trim();
  return trimmedUrl ? `${addressedPrompt}\n${trimmedUrl}` : addressedPrompt;
}

export function personaInitials(displayName: string): string {
  return displayName
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
