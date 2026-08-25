import type {
  AcpRuntime,
  AcpRuntimeCatalogEntry,
  AgentPersona,
  CreateManagedAgentInput,
} from "@/shared/api/types";
import {
  getDefaultPersonaRuntime,
  resolvePersonaRuntime,
  type ResolvePersonaRuntimeResult,
} from "./resolvePersonaRuntime";
import {
  resolveManagedAgentAvatarUrl,
  type UploadMediaBytes,
} from "../ui/managedAgentAvatar";

type RuntimesQueryLike = {
  isFetched: boolean;
  data: readonly AcpRuntimeCatalogEntry[] | undefined;
  refetch: () => Promise<{
    data?: readonly AcpRuntimeCatalogEntry[] | undefined;
  }>;
};

/**
 * Acquire the available-runtime list for a start action (Phase 1B.3.5
 * row 6). Refetch-aware: an unfetched query is fetched instead of being
 * treated as an empty list (which would spuriously refuse every start).
 */
export async function availableRuntimesForStart(
  query: RuntimesQueryLike,
): Promise<AcpRuntime[]> {
  const entries = query.isFetched ? query.data : (await query.refetch()).data;
  return (entries ?? []).filter(
    (runtime): runtime is AcpRuntime => runtime.availability === "available",
  );
}

/**
 * The harness a create falls back to when nothing names one. Mirrors
 * `default_agent_command()` in `managed_agents/discovery.rs`, which resolves
 * the bundled `buzz-agent`.
 */
export const BUNDLED_DEFAULT_RUNTIME_ID = "buzz-agent";

/**
 * The harness a create should use, following the same chain the backend does:
 * the definition's own pin → `global.preferred_runtime` → the bundled default.
 *
 * Every create path needs this, and each one used to inline
 * `runtimes.find((r) => r.id === input.runtime)` instead. Once "Use agent
 * defaults" started submitting no pin, that lookup missed on every
 * defaults-mode create and each copy refused in its own way: the agents page
 * returned false, and the Agent Proposal review threw. Both surfaced as an
 * enabled button that did nothing. One resolver so a fourth caller cannot
 * reintroduce it.
 *
 * `named` is the id that was actually asked for, empty when none was. A caller
 * distinguishes "asked for a harness that is unavailable", which is a real
 * error worth naming, from "asked for nothing", which is legal and inherits.
 */
export function resolveCreateRuntime(
  runtimes: AcpRuntime[],
  pinnedRuntimeId: string | null | undefined,
  globalPreferredRuntimeId: string | null | undefined,
): { named: string; runtime: AcpRuntime | undefined } {
  const named =
    pinnedRuntimeId?.trim() || globalPreferredRuntimeId?.trim() || "";
  return {
    named,
    runtime: runtimes.find(
      (candidate) => candidate.id === (named || BUNDLED_DEFAULT_RUNTIME_ID),
    ),
  };
}

/**
 * Resolve the runtime a definition should start on, refusing when the
 * definition's configured runtime is not available (Phase 1B.3.5 row 1,
 * Wes's call: one consistent refuse-with-actionable-error everywhere —
 * never silently start on a different runtime than configured).
 */
export function resolveStartRuntimeForDefinition(
  persona: AgentPersona,
  runtimes: readonly AcpRuntime[],
  preferredRuntimeId?: string | null,
): { runtime: AcpRuntime; warnings: string[] } {
  // Use the omp-first default preference (omp → buzz-agent → first available)
  // so the shipped signup default surfaces before the bundled sidecar
  // for runtime-less personas (item 13 regression guard).
  const defaultRuntime = getDefaultPersonaRuntime(runtimes, preferredRuntimeId);
  const { runtime, warnings, isOverridden }: ResolvePersonaRuntimeResult =
    resolvePersonaRuntime(persona.runtime, runtimes, defaultRuntime);

  if (!runtime) {
    throw new Error("No available runtime found for this agent.");
  }
  if (isOverridden) {
    throw new Error(
      warnings[0] ??
        "This agent's configured runtime is not available. Install the runtime or edit the agent before starting it.",
    );
  }
  return { runtime, warnings };
}

/**
 * Where the started instance should run when the user picked something other
 * than plain local in the definition-create flow (B5). Absent intent =
 * today's local mapping, byte-identical.
 *
 * - `provider`: remote backend. Mirrors the legacy provider-mode create:
 *   no local ACP/agent/MCP commands are spawned, so none are set;
 *   `startOnAppLaunch` is forced false (remote agents don't auto-start with
 *   the desktop) and `spawnAfterCreate` true.
 * - `mesh`: relay-mesh compute. The preset patch carries the instance
 *   commands/env the legacy dialog fanned into its field state; env lands in
 *   record env_vars (the instance-override layer — the dial pointer is
 *   per-instance runtime state, never definition env). `harnessOverride`
 *   is true because the preset commands deliberately override the
 *   definition's runtime preference.
 */
export type BackendIntent = {
  type: "provider";
  id: string;
  config: Record<string, unknown>;
};

/**
 * The single definition→instance mapping (Phase 1B.3.5 rows 2–4). Every
 * surface that creates a running instance from a definition builds its
 * CreateManagedAgentInput here so the mapping cannot drift per-site.
 *
 * - harnessOverride is true only when the definition names a runtime AND the
 *   picked one matches it. A definition with no runtime is on global defaults
 *   and must submit false: `create_time_agent_command_override` compares the
 *   picked command against the persona-inherited one, and a caller that
 *   resolves through global picks a command that differs from it, so a true
 *   here would be stored as a real pin and freeze the new agent on today's
 *   global harness.
 * - avatarUrl goes through resolveManagedAgentAvatarUrl (base64 data URIs
 *   upload via the injectable `upload`; other URLs pass through unchanged).
 * - envVars are never seeded from the definition: record.env_vars is
 *   agent overrides only and spawn merges the live definition env
 *   underneath. Seeding would manufacture pseudo-overrides that mask
 *   later definition edits made before the first spawn. (Mesh preset env is
 *   the deliberate exception: it is instance-override state, not
 *   definition env.)
 */
export async function buildInstanceInputForDefinition(
  persona: AgentPersona,
  runtime: AcpRuntime,
  upload?: UploadMediaBytes,
  backendIntent?: BackendIntent,
): Promise<CreateManagedAgentInput> {
  const avatarUrl = await resolveManagedAgentAvatarUrl(
    persona.avatarUrl,
    upload,
  );

  const base = {
    name: persona.displayName,
    personaId: persona.id,
    systemPrompt: persona.systemPrompt,
    avatarUrl,
  };

  if (backendIntent?.type === "provider") {
    return {
      ...base,
      harnessOverride: false,
      spawnAfterCreate: true,
      startOnAppLaunch: false,
      backend: {
        type: "provider",
        id: backendIntent.id,
        config: backendIntent.config,
      },
    };
  }

  return {
    ...base,
    acpCommand: "buzz-acp",
    agentCommand: runtime.command,
    // Do NOT seed agentArgs from runtime.defaultArgs: record.agent_args must
    // remain empty so spawn resolves args live from the definition on every
    // start.  Seeding here would freeze the args at create-time, silently
    // ignoring any later definition-arg edits (Thufir F5 / phase B-5).
    // envVars are intentionally never seeded for the same reason (see comment
    // at top of this function).
    agentArgs: [],
    mcpCommand: runtime.mcpCommand ?? "",
    // A definition with no runtime of its own is on global defaults, so there
    // is nothing for the user to have deliberately diverged from and this must
    // be false. It used to be true for that case, which mattered once the
    // caller began resolving the harness through global: the picked command
    // then differs from the persona-inherited one, so
    // `create_time_agent_command_override` stores it as a real pin. The new
    // agent would be born stamped with today's global harness and stop
    // following global from that moment — the exact create-time stamping the
    // one-shot migration exists to clear.
    harnessOverride: Boolean(persona.runtime) && persona.runtime === runtime.id,
    model: persona.model ?? undefined,
    provider: persona.provider ?? undefined,
    spawnAfterCreate: true,
    startOnAppLaunch: true,
    backend: { type: "local" },
  };
}
