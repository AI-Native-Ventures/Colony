/**
 * The one place onboarding decides how a new owner's agents are powered.
 *
 * Every owner-led journey that ends with someone landing in their own Welcome
 * channel runs this, through `CommunityOnboardingFlow.finalize`: a first
 * community, and a returning founder creating another one. It used to run
 * only on the second of those, from a screen of its own, so a brand-new owner
 * reached Welcome with `credential_mode: "byok"` and no provider,
 * `resolveAgentReadiness` answered `{ready: false}`, and the first thing
 * Colony said to them was `WELCOME_KICKOFF_PROVIDER_MESSAGE`: a Settings
 * errand instead of their team.
 */

import { isColonyCreditsEligible } from "@/features/agents/ui/colonyCreditsEligibility";
import { provisioningFromConfig } from "@/features/communities/colonyProvisioning";
import { fetchColonyProvisioningConfig } from "@/features/communities/hostedCommunityApi";
import { resolveAgentReadiness } from "@/features/onboarding/ui/agentReadiness";
import { discoverAcpRuntimes, installAcpRuntime } from "@/shared/api/tauri";
import {
  getGlobalAgentConfig,
  setGlobalAgentConfig,
} from "@/shared/api/tauriGlobalAgentConfig";
import type {
  AcpRuntimeCatalogEntry,
  GlobalAgentConfig,
} from "@/shared/api/types";
import {
  COLONY_AGENT_RUNTIME_ID,
  configForAutomaticCli,
  defaultColonyAgentConfig,
  selectAutomaticRuntime,
} from "./automaticRuntime";

export type AutomaticAgentSetupSkipReason =
  /** A working agent path already exists; never overwrite one. */
  | "already-configured"
  /** This relay does not host agents, so Colony Credits cannot be used here. */
  | "relay-has-no-hosted-agent"
  /** The hosted config names a pair Colony Credits cannot serve. */
  | "provider-not-eligible";

export type AutomaticAgentPlan =
  | {
      action: "configure";
      route: "cli" | "colony-agent";
      runtimeId: string;
      config: GlobalAgentConfig;
    }
  | { action: "skip"; reason: AutomaticAgentSetupSkipReason };

/**
 * Everything this module touches outside itself. Callers override a member
 * when they need their own wiring, and tests hand in the whole set so the
 * decision runs under plain node with no Tauri host and no live relay.
 */
export type AutomaticAgentSetupIo = {
  listRuntimes: () => Promise<AcpRuntimeCatalogEntry[]>;
  loadConfig: () => Promise<GlobalAgentConfig>;
  saveConfig: (config: GlobalAgentConfig) => Promise<unknown>;
  installRuntime: (runtimeId: string) => Promise<unknown>;
  loadProvisioning: typeof fetchColonyProvisioningConfig;
};

const WIRED_IO: AutomaticAgentSetupIo = {
  listRuntimes: discoverAcpRuntimes,
  loadConfig: getGlobalAgentConfig,
  saveConfig: setGlobalAgentConfig,
  installRuntime: installAcpRuntime,
  loadProvisioning: fetchColonyProvisioningConfig,
};

/**
 * Whether the connected relay hosts agents for its members.
 *
 * Reuses the provisioning surface the create form gates on: a relay names a
 * domain and says `self_serve` when it mints communities for people, and that
 * is the same deployment that runs the Colony Credits gateway. A relay that
 * answers neither (a local dev relay, or one too old to have the endpoint at
 * all) 404s that gateway, so a `colony_credits` config written against it
 * fails on the agent's first turn. Not knowing is treated as "no": the write
 * is the irreversible half, and being wrong about it costs a working agent.
 */
async function relayHostsAgents(io: AutomaticAgentSetupIo): Promise<boolean> {
  try {
    return provisioningFromConfig(await io.loadProvisioning()).selfServe;
  } catch {
    return false;
  }
}

/**
 * What to write, given this machine's runtimes, the config already on it, and
 * whether the relay can back the hosted route.
 *
 * Pure: the caller performs the write. Mirrors the two routes
 * `selectAutomaticRuntime` draws, a CLI the user is already logged in to or
 * the bundled Colony Agent on Colony Credits.
 */
export function planAutomaticAgentConfig(
  runtimes: readonly AcpRuntimeCatalogEntry[],
  current: GlobalAgentConfig,
  relayCanHostAgents: boolean,
): AutomaticAgentPlan {
  // A config that already points at a working runtime is left alone:
  // onboarding fills a gap, it never repoints an agent that works. The
  // question is asked of the *preferred* runtime rather than the machine as a
  // whole, because "some CLI on this computer is logged in" is not a choice
  // anyone made. That machine still needs the CLI pinned below, which is what
  // tells the Welcome team which harness to run on.
  if (resolveAgentReadiness(runtimes, current, "preferred").ready) {
    return { action: "skip", reason: "already-configured" };
  }

  // Colony Credits is a decision someone made, not a default, so a machine
  // already on it stays on it even when a CLI turns up: `configForAutomaticCli`
  // would quietly move them back to BYOK. What may still change is the shape of
  // the hosted config, which the branch below rewrites to the pair the gateway
  // actually serves.
  const choice = selectAutomaticRuntime(runtimes);
  if (choice.route === "cli" && current.credential_mode !== "colony_credits") {
    return {
      action: "configure",
      route: "cli",
      runtimeId: choice.runtimeId,
      config: configForAutomaticCli(current, choice.runtimeId),
    };
  }

  if (!relayCanHostAgents) {
    return { action: "skip", reason: "relay-has-no-hosted-agent" };
  }

  const config = defaultColonyAgentConfig(current);
  // The last guard before the write, against the same matrix the spawn
  // preflight uses (`managed_agents/runtime/provisioned.rs`). Colony Credits
  // serves this runtime only on an OpenAI-dialect provider; anything else is
  // refused when the agent starts, and a team that never speaks is worse than
  // a setting the user can still go and fix.
  if (!isColonyCreditsEligible(COLONY_AGENT_RUNTIME_ID, config.provider)) {
    return { action: "skip", reason: "provider-not-eligible" };
  }
  return {
    action: "configure",
    route: "colony-agent",
    runtimeId: COLONY_AGENT_RUNTIME_ID,
    config,
  };
}

async function applyPlan(plan: AutomaticAgentPlan, io: AutomaticAgentSetupIo) {
  if (plan.action === "skip") return plan;
  if (plan.route === "colony-agent") {
    // Colony Agent ships with the desktop app, so this downloads nothing: it
    // re-resolves the command and refreshes the catalog, which is what flips
    // the runtime to `available`. Readiness requires that, so skipping it
    // would leave a correct config that still reads as unconfigured.
    await io.installRuntime(plan.runtimeId);
  }
  await io.saveConfig(plan.config);
  return plan;
}

/**
 * Configure an agent path for this machine, if it does not already have one.
 *
 * Callers await this *before* handing over to the Welcome channel: the kickoff
 * reads readiness on its first render there and posts one of two openings
 * accordingly, so a write that lands afterwards changes nothing the new owner
 * sees.
 */
export async function ensureAutomaticAgentConfig(
  overrides: Partial<AutomaticAgentSetupIo> = {},
): Promise<AutomaticAgentPlan> {
  const io = { ...WIRED_IO, ...overrides };
  const [runtimes, current] = await Promise.all([
    io.listRuntimes(),
    io.loadConfig(),
  ]);
  // Plan without the relay first. Only the hosted route needs an answer from
  // it, so a machine that is already configured, or that has a CLI to pin,
  // never pays for the round trip.
  const offline = planAutomaticAgentConfig(runtimes, current, false);
  const plan =
    offline.action === "skip" && offline.reason === "relay-has-no-hosted-agent"
      ? planAutomaticAgentConfig(runtimes, current, await relayHostsAgents(io))
      : offline;
  return applyPlan(plan, io);
}
