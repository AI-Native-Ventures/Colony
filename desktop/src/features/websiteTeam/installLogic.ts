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

  if (personas.length < 4 || missingAgents > 0 || failedSkills.length > 0) {
    const reasons: string[] = [];
    if (personas.length < 4 || missingAgents > 0) {
      reasons.push(
        `${missingAgents > 0 ? missingAgents : 4 - personas.length} of the four agents are missing`,
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
  started: boolean;
  error: string | null;
  needsConfiguration: boolean;
};

export type AgentStartSummary = {
  started: number;
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
  const failed = outcomes.filter((outcome) => !outcome.started);
  return {
    started: outcomes.filter((outcome) => outcome.started).length,
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

export function personaInitials(displayName: string): string {
  return displayName
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
