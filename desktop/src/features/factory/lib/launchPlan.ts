/**
 * What the Factory launcher has to do, worked out before anything is called.
 *
 * The dialog collects a form; launching it touches four systems in order
 * (create or update the agent, join the channel, post the brief, open the
 * tile). Deciding *what* to do is separated from doing it so the decision is
 * testable without a bridge: which of create/update applies, what the create
 * input carries, and whether the form is even launchable.
 */
import { applyEffortToEnvVars } from "@/features/factory/lib/agentTileChips";

export type LaunchSelection =
  | { type: "persona"; id: string }
  | { type: "agent"; pubkey: string };

/** Form state, all strings: `""` always means "leave it inherited". */
export type LaunchAgentFormState = {
  /** `persona:<id>` or `agent:<pubkey>`. */
  selectionId: string;
  teamId: string;
  runtimeId: string;
  model: string;
  effort: string;
  brief: string;
};

export type LaunchAgentPlan = {
  selection: LaunchSelection;
  /** Set for a persona pick: a managed agent has to be minted first. */
  create: {
    personaId: string;
    teamId: string | null;
    runtimeId: string | null;
    model: string | null;
    envVars: Record<string, string>;
  } | null;
  /** Set for an existing agent whose model or effort the form changed. */
  update: {
    pubkey: string;
    model?: string | null;
    envVars?: Record<string, string>;
  } | null;
  /** The message posted into the project channel; becomes the thread root. */
  brief: string;
};

export type LaunchPlanResult =
  | { ok: true; plan: LaunchAgentPlan }
  | { ok: false; problem: string };

type PersonaLike = {
  id: string;
  runtime?: string | null;
  model?: string | null;
};

type AgentLike = {
  pubkey: string;
  model?: string | null;
  envVars?: Record<string, string> | null;
};

/** Split a `persona:<id>` / `agent:<pubkey>` option value. */
export function parseLaunchSelectionId(value: string): LaunchSelection | null {
  const separator = value.indexOf(":");
  if (separator === -1) return null;
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!id) return null;
  if (type === "persona") return { type: "persona", id };
  if (type === "agent") return { type: "agent", pubkey: id };
  return null;
}

/** Build the option value for a selection. Inverse of the parser above. */
export function launchSelectionId(selection: LaunchSelection): string {
  return selection.type === "persona"
    ? `persona:${selection.id}`
    : `agent:${selection.pubkey}`;
}

/**
 * Decide what launching this form means, or why it cannot be launched.
 *
 * An existing agent is never rewritten with values it already has: the update
 * step is null unless the form actually changed the model or the effort, so a
 * plain "launch it again" does not churn the record.
 */
export function planAgentLaunch(
  form: LaunchAgentFormState,
  context: {
    personas: readonly PersonaLike[];
    agents: readonly AgentLike[];
  },
): LaunchPlanResult {
  const selection = parseLaunchSelectionId(form.selectionId);
  if (!selection) return { ok: false, problem: "Pick an employee to launch." };

  const brief = form.brief.trim();
  if (!brief) {
    return { ok: false, problem: "Write a brief so the agent knows the job." };
  }

  const model = form.model.trim();
  const effort = form.effort.trim();

  if (selection.type === "persona") {
    const persona = context.personas.find(
      (candidate) => candidate.id === selection.id,
    );
    if (!persona) {
      return { ok: false, problem: "That employee is no longer available." };
    }
    return {
      ok: true,
      plan: {
        selection,
        create: {
          personaId: persona.id,
          teamId: form.teamId.trim() || null,
          runtimeId: form.runtimeId.trim() || persona.runtime?.trim() || null,
          model: model || persona.model?.trim() || null,
          // Record env is the instance-override layer, so it carries only what
          // this launch actually pinned. Persona env stays underneath it.
          envVars: applyEffortToEnvVars({}, effort),
        },
        update: null,
        brief,
      },
    };
  }

  const agent = context.agents.find(
    (candidate) => candidate.pubkey === selection.pubkey,
  );
  if (!agent) {
    return { ok: false, problem: "That agent is no longer on this device." };
  }

  const nextEnvVars = applyEffortToEnvVars(agent.envVars, effort);
  const envChanged = !sameEnvVars(agent.envVars ?? {}, nextEnvVars);
  const modelChanged = model !== (agent.model?.trim() ?? "");

  return {
    ok: true,
    plan: {
      selection,
      create: null,
      update:
        envChanged || modelChanged
          ? {
              pubkey: agent.pubkey,
              ...(modelChanged ? { model: model || null } : {}),
              ...(envChanged ? { envVars: nextEnvVars } : {}),
            }
          : null,
      brief,
    },
  };
}

function sameEnvVars(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}
