import { invokeTauri } from "@/shared/api/tauri";

/**
 * Safe recipe metadata and install result for the bundled Website Manager
 * team. Mirrors `managed_agents/website_team` in the native host.
 *
 * The native result deliberately carries no identity keys: only persona ids,
 * agent pubkeys/names, roles, colors, publication status, and skill status.
 */

export type WebsiteTeamRecipePersona = {
  slug: string;
  personaId: string;
  displayName: string;
  roleId: string;
  roleTitle: string;
  tier: "leader" | "worker" | string;
  colorIndex: number;
  skills: string[];
};

export type WebsiteTeamRecipeSkill = {
  name: string;
  description: string;
  version: number;
};

export type WebsiteTeamRecipe = {
  id: string;
  name: string;
  version: string;
  teamSlug: string;
  outcome: string;
  examplePrompt: string;
  integrationNote: string;
  personas: WebsiteTeamRecipePersona[];
  skills: WebsiteTeamRecipeSkill[];
};

export type PublicationStatus = "published" | "queued" | "missing";

export type PublicationEntry = {
  id: string;
  status: PublicationStatus;
};

export type WebsiteTeamPublication = {
  team: PublicationStatus;
  personas: PublicationEntry[];
  agents: PublicationEntry[];
  detail: string | null;
};

export type InstalledWebsitePersona = {
  personaId: string;
  slug: string;
  displayName: string;
  roleId: string;
  roleTitle: string;
  tier: "leader" | "worker" | string;
  colorIndex: number;
  agentPubkey: string;
  agentName: string;
  managerPubkey: string | null;
  created: boolean;
  assignedSkills: string[];
};

export type InstalledWebsiteSkill = {
  name: string;
  path: string;
  status:
    | "installed"
    | "updated"
    | "unchanged"
    | "preserved"
    | "failed"
    | string;
  detail: string | null;
};

export type InstallWebsiteTeamResult = {
  recipeId: string;
  recipeVersion: string;
  relayUrl: string;
  communityKey: string;
  ownerPubkey: string;
  teamId: string;
  teamName: string;
  teamExisted: boolean;
  channelId: string | null;
  seedUrl: string | null;
  starterPrompt: string | null;
  personas: InstalledWebsitePersona[];
  skills: InstalledWebsiteSkill[];
  publication: WebsiteTeamPublication;
  createdAgents: number;
  reconciled: boolean;
  /** True when this run refreshed provisioned content to the current recipe version. */
  upgraded: boolean;
  /** Recipe version the upgrade moved from, when it is known. */
  upgradedFrom: string | null;
  /** Recipe version the upgrade moved to, when an upgrade happened. */
  upgradedTo: string | null;
  notes: string[];
};

export type InstallWebsiteTeamInput = {
  channelId: string;
  seedUrl?: string;
  starterPrompt?: string;
};

/** Durable native install journal entry for one `(community, owner)` scope. */
export type WebsiteTeamInstallStatus = {
  scope_key: string;
  owner_pubkey: string;
  relay_url: string;
  team_id: string;
  persona_ids: string[];
  agent_pubkeys: string[];
  request_ids: string[];
  recipe_version: string;
  channel_id: string | null;
  upgraded_from?: string | null;
  upgraded_to?: string | null;
  updated_at: string;
};

export async function getWebsiteTeamRecipe(): Promise<WebsiteTeamRecipe> {
  return invokeTauri<WebsiteTeamRecipe>("website_team_recipe");
}

/**
 * The last completed install for the active community, if any. Used to show
 * "already installed" before a repeat click reconciles instead of duplicating.
 */
export async function getWebsiteTeamInstallStatus(): Promise<WebsiteTeamInstallStatus | null> {
  return invokeTauri<WebsiteTeamInstallStatus | null>(
    "website_team_install_status",
  );
}

/**
 * Install (or reconcile) the Website Manager team in the active community.
 *
 * Idempotent: a repeat call returns the existing canonical records instead of
 * creating duplicates. The response never contains identity keys.
 */
export async function installWebsiteTeam(
  input: InstallWebsiteTeamInput,
): Promise<InstallWebsiteTeamResult> {
  return invokeTauri<InstallWebsiteTeamResult>("install_website_team", {
    input: {
      channelId: input.channelId,
      seedUrl: input.seedUrl,
      starterPrompt: input.starterPrompt,
    },
  });
}
