import * as React from "react";
import { toast } from "sonner";

import {
  useAttachManagedAgentToChannelMutation,
  useAvailableAcpRuntimes,
  useCreateManagedAgentMutation,
  useManagedAgentsQuery,
  usePersonasQuery,
  useTeamsQuery,
  useUpdateManagedAgentMutation,
} from "@/features/agents/hooks";
import { useGlobalAgentConfig } from "@/features/agents/useGlobalAgentConfig";
import {
  buildInstanceInputForDefinition,
  resolveStartRuntimeForDefinition,
} from "@/features/agents/lib/instanceInputForDefinition";
import { getProviderEffortConfig } from "@/features/agents/ui/buzzAgentConfig";
import {
  launchSelectionId,
  planAgentLaunch,
  type LaunchAgentFormState,
} from "@/features/factory/lib/launchPlan";
import {
  LaunchAgentFields,
  type LaunchAgentOption,
} from "@/features/factory/ui/LaunchAgentFields";
import { sendChannelMessage } from "@/shared/api/sendChannelMessage";
import type { AgentPersona, ManagedAgent } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

const EMPTY_FORM: LaunchAgentFormState = {
  selectionId: "",
  teamId: "",
  runtimeId: "",
  model: "",
  effort: "",
  brief: "",
};

export type LaunchedAgent = {
  pubkey: string;
  name: string;
  threadRootId: string;
};

/**
 * Launch an agent into the Factory: pick an employee, say what the job is, and
 * the dialog mints or reuses the agent, puts it in the project channel, posts
 * the brief as the thread root, and hands the tab back to the caller.
 *
 * A failure anywhere leaves the dialog open with the form intact — the user
 * has just typed a brief, and throwing it away to show an error is worse than
 * the error.
 */
export function LaunchAgentDialog({
  channelId,
  onLaunched,
  onOpenChange,
  open,
}: {
  channelId: string;
  onLaunched: (launched: LaunchedAgent) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}): React.JSX.Element {
  const personasQuery = usePersonasQuery({ enabled: open });
  const agentsQuery = useManagedAgentsQuery();
  const teamsQuery = useTeamsQuery();
  const runtimesQuery = useAvailableAcpRuntimes({ enabled: open });
  const { globalConfig } = useGlobalAgentConfig();
  const createAgent = useCreateManagedAgentMutation();
  const updateAgent = useUpdateManagedAgentMutation();
  const attachToChannel = useAttachManagedAgentToChannelMutation(channelId);

  const [form, setForm] = React.useState<LaunchAgentFormState>(EMPTY_FORM);
  const [launching, setLaunching] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setForm(EMPTY_FORM);
    setProblem(null);
  }, [open]);

  const personas = React.useMemo(
    () => (personasQuery.data ?? []).filter((persona) => persona.isActive),
    [personasQuery.data],
  );
  const agents = agentsQuery.data ?? [];

  const employees: LaunchAgentOption[] = React.useMemo(
    () => [
      ...agents.map((agent) => ({
        label: `${agent.name} (running here)`,
        value: launchSelectionId({ type: "agent", pubkey: agent.pubkey }),
      })),
      ...personas.map((persona) => ({
        label: persona.roleTitle
          ? `${persona.displayName} · ${persona.roleTitle}`
          : persona.displayName,
        value: launchSelectionId({ type: "persona", id: persona.id }),
      })),
    ],
    [agents, personas],
  );

  const selected = resolveSelected(form.selectionId, personas, agents);
  const teams: LaunchAgentOption[] = React.useMemo(() => {
    const personaId =
      selected?.type === "persona"
        ? selected.persona.id
        : (selected?.agent.personaId ?? null);
    if (!personaId) return [];
    return (teamsQuery.data ?? [])
      .filter((team) => team.personaIds.includes(personaId))
      .map((team) => ({ label: team.name, value: team.id }));
  }, [selected, teamsQuery.data]);

  const runtimes: LaunchAgentOption[] = React.useMemo(
    () =>
      (runtimesQuery.data ?? []).map((runtime) => ({
        label: runtime.label,
        value: runtime.id,
      })),
    [runtimesQuery.data],
  );

  const inheritedModel =
    selected?.type === "persona"
      ? selected.persona.model
      : (selected?.agent.model ?? null);
  const inheritedProvider =
    selected?.type === "persona"
      ? selected.persona.provider
      : (selected?.agent.provider ?? null);
  const effortConfig = getProviderEffortConfig(
    inheritedProvider ?? "",
    form.model.trim() || inheritedModel || undefined,
  );

  const handleChange = React.useCallback(
    (patch: Partial<LaunchAgentFormState>) => {
      setProblem(null);
      setForm((current) => {
        const next = { ...current, ...patch };
        // A different employee carries a different harness, model and team, so
        // its inherited values must not be left pinned from the last pick.
        if (patch.selectionId !== undefined) {
          return { ...next, teamId: "", runtimeId: "", model: "", effort: "" };
        }
        return next;
      });
    },
    [],
  );

  async function handleLaunch() {
    const planned = planAgentLaunch(form, { personas, agents });
    if (!planned.ok) {
      setProblem(planned.problem);
      return;
    }
    const { plan } = planned;
    setLaunching(true);
    setProblem(null);
    try {
      let agent: ManagedAgent;
      if (plan.create) {
        const persona = personas.find(
          (candidate) => candidate.id === plan.create?.personaId,
        );
        if (!persona) throw new Error("That employee is no longer available.");
        const input = await buildInstanceInputForDefinition(
          persona,
          resolveLaunchRuntime(
            persona,
            plan.create.runtimeId,
            runtimesQuery.data ?? [],
            globalConfig.preferred_runtime,
          ),
        );
        const created = await createAgent.mutateAsync({
          ...input,
          ...(plan.create.model ? { model: plan.create.model } : {}),
          ...(plan.create.teamId ? { teamId: plan.create.teamId } : {}),
          envVars: plan.create.envVars,
        });
        agent = created.agent;
      } else {
        const existing = agents.find(
          (candidate) =>
            plan.selection.type === "agent" &&
            candidate.pubkey === plan.selection.pubkey,
        );
        if (!existing) throw new Error("That agent is no longer available.");
        agent = plan.update
          ? (await updateAgent.mutateAsync(plan.update)).agent
          : existing;
      }

      // Membership and the start ride the same call: a running agent only
      // discovers a channel it is a member of.
      const attached = await attachToChannel.mutateAsync({
        agent,
        ensureRunning: true,
      });
      agent = attached.agent;

      const posted = await sendChannelMessage({
        channelId,
        content: plan.brief,
        mentionPubkeys: [agent.pubkey],
      });

      onLaunched({
        pubkey: agent.pubkey,
        name: agent.name,
        threadRootId: posted.rootEventId ?? posted.eventId,
      });
      onOpenChange(false);
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "Could not launch the agent.";
      setProblem(message);
      toast.error(message);
    } finally {
      setLaunching(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-xl" data-testid="launch-agent-dialog">
        <DialogHeader>
          <DialogTitle>Launch an agent</DialogTitle>
          <DialogDescription>
            It joins this project channel, reads the brief, and works in a tile
            you can watch.
          </DialogDescription>
        </DialogHeader>

        <LaunchAgentFields
          disabled={launching}
          effortDefault={effortConfig.defaultValue}
          effortValid={effortConfig.validValues}
          employees={employees}
          form={form}
          modelPlaceholder={inheritedModel ?? "Inherit from employee"}
          onChange={handleChange}
          runtimes={runtimes}
          teams={teams}
        />

        {problem ? (
          <p
            className="text-sm text-destructive"
            data-testid="launch-agent-error"
            role="alert"
          >
            {problem}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            data-testid="launch-agent-submit"
            disabled={launching}
            onClick={() => void handleLaunch()}
            type="button"
          >
            {launching ? "Launching..." : "Launch agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type SelectedEmployee =
  | { type: "persona"; persona: AgentPersona }
  | { type: "agent"; agent: ManagedAgent };

function resolveSelected(
  selectionId: string,
  personas: readonly AgentPersona[],
  agents: readonly ManagedAgent[],
): SelectedEmployee | null {
  if (selectionId.startsWith("persona:")) {
    const persona = personas.find(
      (candidate) => candidate.id === selectionId.slice("persona:".length),
    );
    return persona ? { type: "persona", persona } : null;
  }
  if (selectionId.startsWith("agent:")) {
    const agent = agents.find(
      (candidate) => candidate.pubkey === selectionId.slice("agent:".length),
    );
    return agent ? { type: "agent", agent } : null;
  }
  return null;
}

/**
 * The runtime a create should spawn on: an explicitly picked harness must be
 * installed, and an inherited one goes through the same resolver every other
 * create path uses.
 */
function resolveLaunchRuntime(
  persona: AgentPersona,
  pinnedRuntimeId: string | null,
  runtimes: readonly import("@/shared/api/types").AcpRuntime[],
  preferredRuntimeId: string | null | undefined,
) {
  if (pinnedRuntimeId) {
    const pinned = runtimes.find(
      (candidate) => candidate.id === pinnedRuntimeId,
    );
    if (!pinned) {
      throw new Error(`The ${pinnedRuntimeId} harness is not installed.`);
    }
    return pinned;
  }
  return resolveStartRuntimeForDefinition(persona, runtimes, preferredRuntimeId)
    .runtime;
}
