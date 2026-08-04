import {
  buildInstanceInputForDefinition,
  resolveStartRuntimeForDefinition,
} from "@/features/agents/lib/instanceInputForDefinition";
import {
  addChannelMembers,
  createManagedAgent,
  discoverAcpRuntimes,
  getChannelMembers,
  listManagedAgents,
  updateManagedAgent,
} from "@/shared/api/tauri";
import { getGlobalAgentConfig } from "@/shared/api/tauriGlobalAgentConfig";
import { listPersonas, setPersonaActive } from "@/shared/api/tauriPersonas";
import type {
  AcpRuntime,
  AgentPersona,
  ChannelMember,
  CreateManagedAgentInput,
  ManagedAgent,
} from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import {
  STARTER_PERSONA_IDS,
  starterPersonaName,
} from "@/shared/constants/starterPersonas";

export const WELCOME_GUIDE_PERSONA_ID = STARTER_PERSONA_IDS.fizz;
export const WELCOME_GUIDE_AGENT_NAME = starterPersonaName(
  WELCOME_GUIDE_PERSONA_ID,
);
export const WELCOME_TEAM_ID = "builtin-team:welcome";
export const WELCOME_GUIDE_INTRO_MARKER = "buzz-welcome-intro.v1";
const LEGACY_WELCOME_GUIDE_AGENT_NAME = "Kit";
export const LEGACY_WELCOME_GUIDE_SYSTEM_PROMPT =
  "You are Kit, Sprout's friendly welcome guide. Help new users understand the community, channels, messages, and agents. Keep introductions concise, practical, and warm.";
export const WELCOME_GUIDE_INTRO_MESSAGE = `Hi, I'm ${WELCOME_GUIDE_AGENT_NAME}, your Chief of Staff.\n\nColony is where we'll run the company together. I'll learn how the business works, propose the smallest useful team, coordinate work, and bring decisions back here.\n\nSend me the company website. If there isn't one yet, say so and I'll ask a few focused questions instead. I won't create the company or start work until you approve the blueprint.`;

export type WelcomeTeamRole = "lead" | "teammate";

export type WelcomeTeamStarterDefinition = Readonly<{
  name: string;
  personaId: string;
  role: WelcomeTeamRole;
  roleId: string;
}>;

/**
 * The only employee provisioned before the company blueprint is approved.
 *
 * Colony opens as a conversation with one Chief of Staff, not a staffed team.
 * The rest of the roster is proposed from what the business actually turns out
 * to need and created on approval, so nothing is deployed, started, or paid for
 * on the user's behalf before they have agreed to it.
 *
 * Honey and Bumble are deliberately absent. Their built-in definitions still
 * exist and any customization a user already made is untouched — they are
 * simply no longer auto-provisioned.
 */
export const WELCOME_TEAM_STARTERS = [
  {
    name: starterPersonaName(STARTER_PERSONA_IDS.fizz),
    personaId: STARTER_PERSONA_IDS.fizz,
    role: "lead",
    roleId: "chief-of-staff",
  },
] as const satisfies readonly WelcomeTeamStarterDefinition[];

export type WelcomeTeamAgents = [ManagedAgent];

const welcomeTeamPromises = new Map<
  string,
  Promise<WelcomeTeamAgents | null>
>();

function normalizeRelayUrl(relayUrl: string | null | undefined) {
  return relayUrl?.trim().replace(/\/+$/, "") ?? null;
}

function isAgentScopedToRelay(agent: ManagedAgent, relayUrl?: string | null) {
  const targetRelayUrl = normalizeRelayUrl(relayUrl);
  if (!targetRelayUrl) {
    return true;
  }
  return normalizeRelayUrl(agent.relayUrl) === targetRelayUrl;
}

function isBuiltInWelcomeGuideAgent(agent: ManagedAgent) {
  return agent.personaId === WELCOME_GUIDE_PERSONA_ID;
}

function isLegacyKitWelcomeGuideAgent(agent: ManagedAgent) {
  return (
    agent.name.trim().toLowerCase() ===
      LEGACY_WELCOME_GUIDE_AGENT_NAME.toLowerCase() &&
    agent.systemPrompt?.trim() === LEGACY_WELCOME_GUIDE_SYSTEM_PROMPT
  );
}

function isWelcomeGuideAgent(agent: ManagedAgent) {
  return (
    isBuiltInWelcomeGuideAgent(agent) || isLegacyKitWelcomeGuideAgent(agent)
  );
}

function pickAgentByStatus(agents: ManagedAgent[]) {
  return (
    agents.find((agent) => agent.status === "running") ??
    agents.find((agent) => agent.status === "deployed") ??
    agents[0] ??
    null
  );
}

export function pickWelcomeGuideAgent(agents: ManagedAgent[]) {
  return pickAgentByStatus(agents.filter(isWelcomeGuideAgent));
}

export function pickWelcomeGuideAgentForRelay(
  agents: ManagedAgent[],
  relayUrl?: string | null,
) {
  return pickAgentByStatus(
    agents.filter(
      (agent) =>
        isWelcomeGuideAgent(agent) && isAgentScopedToRelay(agent, relayUrl),
    ),
  );
}

/** Find the preferred managed instance for one starter persona and relay. */
export function pickWelcomeTeamStarterAgentForRelay(
  agents: ManagedAgent[],
  starter: WelcomeTeamStarterDefinition,
  relayUrl?: string | null,
) {
  return pickAgentByStatus(
    agents.filter(
      (agent) =>
        agent.teamId === WELCOME_TEAM_ID &&
        agent.personaId === starter.personaId &&
        isAgentScopedToRelay(agent, relayUrl),
    ),
  );
}

/** Pubkeys belonging to any managed Welcome Team persona on this relay. */
export async function getWelcomeTeamAgentPubkeys(relayUrl?: string | null) {
  const personaIds = new Set<string>(
    WELCOME_TEAM_STARTERS.map(({ personaId }) => personaId),
  );
  return (await listManagedAgents())
    .filter(
      (agent) =>
        agent.teamId === WELCOME_TEAM_ID &&
        agent.personaId !== null &&
        personaIds.has(agent.personaId) &&
        isAgentScopedToRelay(agent, relayUrl),
    )
    .map((agent) => agent.pubkey);
}

/** Legacy Fizz/Kit lookup retained for existing channel reuse checks. */
export async function getWelcomeGuideAgentPubkeys(relayUrl?: string | null) {
  return (await listManagedAgents())
    .filter(
      (agent) =>
        isWelcomeGuideAgent(agent) && isAgentScopedToRelay(agent, relayUrl),
    )
    .map((agent) => agent.pubkey);
}

export async function activateWelcomeTeamPersonasSequentially(
  inactivePersonaIds: readonly string[],
  activate: (personaId: string) => Promise<unknown>,
) {
  for (const personaId of inactivePersonaIds) {
    await activate(personaId);
  }
}

async function ensureWelcomeTeamPersonasActive() {
  const personas = await listPersonas();
  const personasById = new Map(
    personas.map((persona) => [persona.id, persona]),
  );

  for (const starter of WELCOME_TEAM_STARTERS) {
    if (!personasById.has(starter.personaId)) {
      throw new Error(`${starter.name} agent not found.`);
    }
  }

  // Persona activation is a read-modify-write operation over one shared file.
  // Run these sequentially so concurrent writes cannot lose a teammate's
  // activation and leave Welcome provisioning permanently partial.
  await activateWelcomeTeamPersonasSequentially(
    WELCOME_TEAM_STARTERS.filter(
      ({ personaId }) => !personasById.get(personaId)?.isActive,
    ).map(({ personaId }) => personaId),
    (personaId) => setPersonaActive(personaId, true),
  );
}

/**
 * Whether this community's Welcome channel is already staffed by another
 * member's agents: it has bot members that are not this install's own.
 *
 * Joining a workspace must not mint a second starter team next to the one
 * that is already there - "Chief of Staff" is one colleague, not one per
 * member (docs/design/role-agents.html, phase 1).
 */
export function communityAlreadyStaffed(
  members: readonly Pick<ChannelMember, "pubkey" | "role" | "isAgent">[],
  ownAgentPubkeys: ReadonlySet<string>,
) {
  return members.some(
    (member) =>
      (member.role === "bot" || member.isAgent) &&
      !ownAgentPubkeys.has(normalizePubkey(member.pubkey)),
  );
}

async function ensureWelcomeTeamMembership(
  channelId: string,
  agents: WelcomeTeamAgents,
) {
  const members = await getChannelMembers(channelId).catch(() => []);
  const memberPubkeys = new Set(
    members.map((member) => normalizePubkey(member.pubkey)),
  );
  const missingAgents = agents.filter(
    (agent) => !memberPubkeys.has(normalizePubkey(agent.pubkey)),
  );
  if (missingAgents.length === 0) {
    return;
  }

  const result = await addChannelMembers({
    channelId,
    pubkeys: missingAgents.map((agent) => agent.pubkey),
    role: "bot",
  });
  const unexpectedError = result.errors.find(
    ({ error }) => !error.toLowerCase().includes("already"),
  );
  if (unexpectedError) {
    throw new Error(unexpectedError.error);
  }
}

export async function buildWelcomeStarterCreateInput(
  starter: WelcomeTeamStarterDefinition,
  persona: AgentPersona,
  runtimes: readonly AcpRuntime[],
  preferredRuntimeId: string | null,
  relayUrl?: string | null,
): Promise<CreateManagedAgentInput> {
  const { runtime } = resolveStartRuntimeForDefinition(
    persona,
    runtimes,
    preferredRuntimeId,
  );
  return {
    ...(await buildInstanceInputForDefinition(persona, runtime)),
    name: starter.name,
    teamId: WELCOME_TEAM_ID,
    relayUrl: relayUrl ?? undefined,
    spawnAfterCreate: false,
    startOnAppLaunch: false,
    // Workspace agents answer any community member (role-agents phase 1).
    // The relay's membership gate bounds who can reach the channel at all,
    // so "anyone" here means "any member of this workspace", not the world.
    respondTo: "anyone",
  };
}

export function welcomeStarterRuntimeUpdate(
  existing: ManagedAgent,
  desired: CreateManagedAgentInput,
) {
  if (!desired.agentCommand) return null;

  const desiredArgs = desired.agentArgs ?? [];
  const desiredModel = desired.model ?? null;
  const desiredProvider = desired.provider ?? null;
  const desiredMcpCommand = desired.mcpCommand ?? "";
  if (
    existing.agentCommand === desired.agentCommand &&
    existing.agentArgs.join(",") === desiredArgs.join(",") &&
    existing.model === desiredModel &&
    existing.provider === desiredProvider &&
    existing.mcpCommand === desiredMcpCommand
  ) {
    return null;
  }

  return {
    pubkey: existing.pubkey,
    agentCommand: desired.agentCommand,
    harnessOverride: true,
    agentArgs: desiredArgs,
    mcpCommand: desiredMcpCommand,
    model: desiredModel,
    provider: desiredProvider,
  };
}

/**
 * Ensure the complete built-in Welcome Team is ready for kickoff.
 * The team itself is Rust-seeded; this only activates personas, creates any
 * missing relay-scoped instances, and adds all three to Welcome as bots.
 */
async function provisionWelcomeTeam(
  channelId: string,
  relayUrl?: string | null,
): Promise<WelcomeTeamAgents | null> {
  const existingAgents = await listManagedAgents();

  // Join-flow dedup: when another member's fleet already staffs this
  // community and this install never minted its own starter, don't mint one.
  // The existing team's opener is already in the channel history; the joiner
  // simply talks to the workspace's agents. An install that already has its
  // own starter (pre-dedup builds) keeps using it.
  const hasOwnStarter = WELCOME_TEAM_STARTERS.every((starter) =>
    pickWelcomeTeamStarterAgentForRelay(existingAgents, starter, relayUrl),
  );
  if (!hasOwnStarter) {
    const members = await getChannelMembers(channelId).catch(() => []);
    const ownPubkeys = new Set(
      existingAgents.map((agent) => normalizePubkey(agent.pubkey)),
    );
    if (communityAlreadyStaffed(members, ownPubkeys)) {
      return null;
    }
  }

  await ensureWelcomeTeamPersonasActive();
  const [personas, runtimeCatalog, globalConfig] = await Promise.all([
    listPersonas(),
    discoverAcpRuntimes(),
    getGlobalAgentConfig(),
  ]);
  const personasById = new Map(
    personas.map((persona) => [persona.id, persona]),
  );
  const runtimes = runtimeCatalog.filter(
    (runtime): runtime is AcpRuntime => runtime.availability === "available",
  );

  const agents: ManagedAgent[] = [];
  for (const starter of WELCOME_TEAM_STARTERS) {
    const persona = personasById.get(starter.personaId);
    if (!persona) {
      throw new Error(`${starter.name} agent not found.`);
    }
    const desired = await buildWelcomeStarterCreateInput(
      starter,
      persona,
      runtimes,
      globalConfig.preferred_runtime,
      relayUrl,
    );
    const existing = pickWelcomeTeamStarterAgentForRelay(
      existingAgents,
      starter,
      relayUrl,
    );
    if (existing) {
      const runtimeUpdate = welcomeStarterRuntimeUpdate(existing, desired);
      agents.push(
        runtimeUpdate
          ? (await updateManagedAgent(runtimeUpdate)).agent
          : existing,
      );
      continue;
    }

    const created = await createManagedAgent(desired);
    agents.push(created.agent);
  }
  const [chiefOfStaff] = agents;
  if (!chiefOfStaff) {
    throw new Error("Chief of Staff provisioning did not return an agent.");
  }
  // No teammate allowlists to wire: the Chief of Staff is the only employee
  // before approval, and it answers every workspace member (`respondTo`
  // "anyone" from the starter definition; the relay membership gate bounds
  // the audience).
  const welcomeAgents: WelcomeTeamAgents = [chiefOfStaff];
  await ensureWelcomeTeamMembership(channelId, welcomeAgents);
  return welcomeAgents;
}

export function ensureWelcomeTeam(
  channelId: string,
  relayUrl?: string | null,
): Promise<WelcomeTeamAgents | null> {
  const key = `${normalizeRelayUrl(relayUrl) ?? ""}:${channelId}`;
  const current = welcomeTeamPromises.get(key);
  if (current) return current;

  const promise = provisionWelcomeTeam(channelId, relayUrl).finally(() =>
    welcomeTeamPromises.delete(key),
  );
  welcomeTeamPromises.set(key, promise);
  return promise;
}
