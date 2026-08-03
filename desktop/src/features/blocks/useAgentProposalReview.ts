import * as React from "react";
import { useLocation } from "@tanstack/react-router";

import {
  type AgentProposalInstance,
  type AgentProposalSafeAction,
  closeAgentProposalReview,
  subscribeAgentProposalReview,
} from "@/features/blocks/agentProposal";
import { submitBlockAction } from "@/features/blocks/blockActions";
import { notifyAgentProposalActionAcknowledged } from "@/features/blocks/useAgentProposalBroker";
import { useChannelsQuery } from "@/features/channels/hooks";
import {
  useAcpRuntimesQuery,
  useManagedAgentsQuery,
  usePersonasQuery,
} from "@/features/agents/hooks";
import { availableRuntimesForStart } from "@/features/agents/lib/instanceInputForDefinition";
import type { BackendIntent } from "@/features/agents/lib/instanceInputForDefinition";
import { resolveRemoteManagedAgentAvatarUrl } from "@/features/agents/ui/managedAgentAvatar";
import { editPersonaDialogState } from "@/features/agents/ui/personaDialogState";
import type { AgentCreateIntent } from "@/features/agents/ui/agentCreateIntent";
import type {
  CreatePersonaInput,
  UpdatePersonaInput,
} from "@/shared/api/types";

function updateInputFromProposal(
  proposal: Extract<AgentProposalInstance["data"], { mode: "update" }>,
  current: UpdatePersonaInput,
): UpdatePersonaInput {
  return {
    ...current,
    displayName: proposal.displayName ?? current.displayName,
    systemPrompt: proposal.systemPrompt ?? current.systemPrompt,
    runtime: proposal.runtime ?? current.runtime,
    provider: proposal.provider ?? current.provider,
    model: proposal.model ?? current.model,
    ...(proposal.respondTo
      ? {
          behavior: {
            respondTo: proposal.respondTo,
            respondToAllowlist: [],
            parallelism: current.behavior?.parallelism,
          },
        }
      : {}),
  };
}

function toSafeDefinition(
  input: CreatePersonaInput | UpdatePersonaInput,
  avatarUrl: string | undefined,
): AgentProposalSafeAction["definition"] {
  return {
    ...("id" in input ? { id: input.id } : {}),
    displayName: input.displayName,
    ...(avatarUrl ? { avatarUrl } : {}),
    systemPrompt: input.systemPrompt,
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.behavior
      ? {
          behavior: {
            ...(input.behavior.respondTo
              ? { respondTo: input.behavior.respondTo }
              : {}),
            ...(input.behavior.respondToAllowlist
              ? {
                  respondToAllowlist: input.behavior.respondToAllowlist,
                }
              : {}),
            ...(input.behavior.parallelism
              ? { parallelism: input.behavior.parallelism }
              : {}),
          },
        }
      : {}),
  };
}

export function useAgentProposalReview() {
  const location = useLocation();
  const personasQuery = usePersonasQuery();
  const managedAgentsQuery = useManagedAgentsQuery();
  const channelsQuery = useChannelsQuery();
  const runtimesQuery = useAcpRuntimesQuery({ enabled: true });
  const [selectedProposal, setSelectedProposal] =
    React.useState<AgentProposalInstance | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, setIsPending] = React.useState(false);
  const submitInFlight = React.useRef<Promise<boolean> | null>(null);
  const previousPathname = React.useRef(location.pathname);
  const closeReview = React.useCallback(() => {
    setSelectedProposal(null);
    setError(null);
    closeAgentProposalReview();
  }, []);

  React.useEffect(
    () =>
      subscribeAgentProposalReview((proposal) => {
        setError(null);
        setSelectedProposal(proposal);
      }),
    [],
  );

  React.useEffect(() => {
    if (previousPathname.current !== location.pathname && selectedProposal) {
      closeReview();
    }
    previousPathname.current = location.pathname;
  }, [closeReview, location.pathname, selectedProposal]);

  const matchingPersonas = React.useMemo(() => {
    if (selectedProposal?.data.mode !== "update") return [];
    const target = selectedProposal.data.agentName.trim().toLocaleLowerCase();
    return (personasQuery.data ?? []).filter(
      (persona) =>
        persona.displayName.trim().toLocaleLowerCase() === target &&
        !persona.isBuiltIn &&
        !persona.sourceTeam,
    );
  }, [personasQuery.data, selectedProposal]);
  const currentPersona =
    matchingPersonas.length === 1 ? matchingPersonas[0] : undefined;

  function assertProposalOrigin(proposal: AgentProposalInstance) {
    const signerPubkey = proposal.signerPubkey.toLowerCase();
    const channel = (channelsQuery.data ?? []).find(
      (candidate) => candidate.id === proposal.channelId,
    );
    if (
      proposal.data.channelId !== proposal.channelId ||
      proposal.event.pubkey.toLowerCase() !== signerPubkey ||
      !(managedAgentsQuery.data ?? []).some(
        (agent) => agent.pubkey.toLowerCase() === signerPubkey,
      ) ||
      !channel?.isMember ||
      !channel.memberPubkeys.some(
        (pubkey) => pubkey.toLowerCase() === signerPubkey,
      )
    ) {
      throw new Error(
        "An owned agent can only propose changes from a channel you both belong to.",
      );
    }
  }

  function submitOnce(operation: () => Promise<void>) {
    if (submitInFlight.current) return submitInFlight.current;
    const pending = (async () => {
      setError(null);
      setIsPending(true);
      try {
        await operation();
        closeReview();
        return true;
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not submit this Agent Proposal.",
        );
        return false;
      } finally {
        setIsPending(false);
        submitInFlight.current = null;
      }
    })();
    submitInFlight.current = pending;
    return pending;
  }

  async function publishAction(
    proposal: AgentProposalInstance,
    actionId: "agent.create" | "agent.update" | "agent.decline",
    data: AgentProposalSafeAction | { reason?: string },
    backendConfig?: Record<string, unknown>,
  ) {
    const event = await submitBlockAction({
      channelId: proposal.channelId,
      instanceEventId: proposal.event.id,
      manifestId: proposal.manifestId,
      instanceId: proposal.instanceId,
      actionId,
      processorPubkey: proposal.processorPubkey,
      data,
      idempotencyKey: crypto.randomUUID(),
    });
    notifyAgentProposalActionAcknowledged({ event, backendConfig });
  }

  function submitCreate(
    input: CreatePersonaInput | UpdatePersonaInput,
    _intent: AgentCreateIntent,
    backendIntent: BackendIntent | null,
  ): Promise<boolean> {
    return submitOnce(async () => {
      const proposal = selectedProposal;
      if (proposal?.data.mode !== "create" || "id" in input) {
        throw new Error("This Agent Proposal is no longer available.");
      }
      assertProposalOrigin(proposal);
      const runtimes = await availableRuntimesForStart(runtimesQuery);
      const runtime = runtimes.find(
        (candidate) => candidate.id === input.runtime,
      );
      if (!runtime) {
        throw new Error("Choose an available runtime for this agent.");
      }
      // The safe-action schema only accepts https avatar URLs, so inline
      // emoji avatars must be uploaded (rasterized to PNG) before submit.
      const avatarUrl = await resolveRemoteManagedAgentAvatarUrl(
        input.avatarUrl,
        undefined,
        runtime.avatarUrl,
      );
      const action: AgentProposalSafeAction = {
        requestId: proposal.data.requestId,
        definition: toSafeDefinition(input, avatarUrl),
        runOn: backendIntent
          ? { type: "provider", id: backendIntent.id }
          : { type: "local" },
      };
      await publishAction(
        proposal,
        "agent.create",
        action,
        backendIntent?.config,
      );
    });
  }

  function submitUpdate(
    input: CreatePersonaInput | UpdatePersonaInput,
  ): Promise<boolean> {
    return submitOnce(async () => {
      const proposal = selectedProposal;
      if (
        proposal?.data.mode !== "update" ||
        !("id" in input) ||
        input.id !== currentPersona?.id
      ) {
        throw new Error(
          "This Agent Proposal no longer has one editable target.",
        );
      }
      assertProposalOrigin(proposal);
      const avatarUrl = await resolveRemoteManagedAgentAvatarUrl(
        input.avatarUrl,
        undefined,
      );
      const action: AgentProposalSafeAction = {
        requestId: proposal.data.requestId,
        definition: toSafeDefinition(input, avatarUrl),
        runOn: { type: "local" },
      };
      await publishAction(proposal, "agent.update", action);
    });
  }

  function decline(): Promise<boolean> {
    return submitOnce(async () => {
      const proposal = selectedProposal;
      if (!proposal) {
        throw new Error("This Agent Proposal is no longer available.");
      }
      assertProposalOrigin(proposal);
      await publishAction(proposal, "agent.decline", {});
    });
  }

  const createInitialValues = React.useMemo<CreatePersonaInput | null>(
    () =>
      selectedProposal?.data.mode === "create"
        ? {
            displayName: selectedProposal.data.displayName,
            systemPrompt: selectedProposal.data.systemPrompt,
          }
        : null,
    [selectedProposal],
  );

  const editInitialValues = React.useMemo(() => {
    if (selectedProposal?.data.mode !== "update" || !currentPersona)
      return null;
    return updateInputFromProposal(
      selectedProposal.data,
      editPersonaDialogState(currentPersona)
        .initialValues as UpdatePersonaInput,
    );
  }, [currentPersona, selectedProposal]);

  const editError = React.useMemo(() => {
    if (selectedProposal?.data.mode !== "update") return error;
    if (error) return error;
    if (matchingPersonas.length > 1) {
      return "More than one personal agent has that name. Rename it in Agents, then review again.";
    }
    if (!currentPersona) {
      return "Only one editable personal agent definition can be updated.";
    }
    return null;
  }, [currentPersona, error, matchingPersonas.length, selectedProposal]);

  return {
    selectedProposal,
    createInitialValues,
    editInitialValues,
    editError,
    error,
    isPending,
    runtimes: runtimesQuery.data ?? [],
    runtimesLoading: runtimesQuery.isLoading,
    submitCreate,
    submitUpdate,
    decline,
    closeReview,
  };
}
