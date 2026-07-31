import * as React from "react";

import type { TimelineMessage } from "@/features/messages/types";
import type {
  BlockInstanceRef,
  BlockManifest,
  BlockTrust,
} from "@/features/blocks/contracts";
import {
  openAgentProposalReview,
  parseAgentProposalData,
} from "@/features/blocks/agentProposal";
import { validateBlockActionData } from "@/features/blocks/blockValidation";
import {
  resolveApprovalActionInputForSubmission,
  resolveApprovalActionInputs,
  submitBlockAction,
} from "@/features/blocks/blockActions";
import {
  queueRetryableQuestionAction,
  type QueuedQuestionAction,
} from "@/features/blocks/blockActionQueue";

import type {
  BlockActionEnvironment,
  BlockPresentationInteraction,
  BlockSignedInteraction,
} from "./primitives";

type BlockRenderContextValue = {
  actionEnvironment: BlockActionEnvironment;
  actionError: string | null;
  actionNotice: string | null;
  attentionResolution?: "succeeded" | "denied";
};

const BlockRenderContext = React.createContext<BlockRenderContextValue | null>(
  null,
);

function exactChannelId(tags: string[][] | undefined): string | null {
  const matches = tags?.filter((tag) => tag[0] === "h") ?? [];
  if (matches.length !== 1 || matches[0]?.length !== 2) return null;
  return matches[0]?.[1] ?? null;
}

export function BlockRenderProvider({
  children,
  attentionResolution,
  completedActionIds,
  data,
  instance,
  manifest,
  message,
  pendingActionId,
  queueScope,
  questionActionIds,
  trust,
}: {
  children: React.ReactNode;
  attentionResolution?: "succeeded" | "denied";
  completedActionIds: ReadonlySet<string>;
  data: unknown;
  instance: BlockInstanceRef;
  manifest: BlockManifest;
  message: TimelineMessage;
  pendingActionId?: string;
  queueScope?: Pick<QueuedQuestionAction, "relayUrl" | "identityPubkey"> | null;
  questionActionIds: ReadonlySet<string>;
  trust: BlockTrust;
}) {
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionNotice, setActionNotice] = React.useState<string | null>(null);
  const [nowSeconds, setNowSeconds] = React.useState(() =>
    Math.floor(Date.now() / 1000),
  );
  const declaredActionIds = React.useMemo(
    () => new Set(manifest.actions.map((action) => action.id)),
    [manifest.actions],
  );
  const approvalInputs = React.useMemo(
    () =>
      manifest.handle === "approval"
        ? resolveApprovalActionInputs(data, nowSeconds)
        : null,
    [data, manifest.handle, nowSeconds],
  );
  React.useEffect(() => {
    if (
      manifest.handle !== "approval" ||
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data)
    ) {
      return;
    }
    const expiresAt = (data as { expires_at?: unknown }).expires_at;
    if (
      !Number.isSafeInteger(expiresAt) ||
      (expiresAt as number) <= nowSeconds
    ) {
      return;
    }
    const delay = Math.min(
      ((expiresAt as number) - nowSeconds) * 1000 + 50,
      2_147_483_647,
    );
    const timeout = window.setTimeout(
      () => setNowSeconds(Math.floor(Date.now() / 1000)),
      delay,
    );
    return () => window.clearTimeout(timeout);
  }, [data, manifest.handle, nowSeconds]);
  const directActionIds = React.useMemo(() => {
    if (manifest.handle === "agent-proposal") return new Set<string>();
    const direct = new Set(
      manifest.actions.flatMap((action) => {
        if (action.interaction.type !== "signed") return [];
        const schema = action.input_schema;
        if (
          schema &&
          typeof schema === "object" &&
          !Array.isArray(schema) &&
          Array.isArray((schema as { required?: unknown }).required) &&
          ((schema as { required: unknown[] }).required.length ?? 0) > 0
        ) {
          return [];
        }
        return [action.id];
      }),
    );
    if (approvalInputs?.ok) {
      for (const actionId of approvalInputs.inputs.keys()) {
        direct.add(actionId);
      }
    }
    return direct;
  }, [approvalInputs, manifest.actions, manifest.handle]);
  const resolvingActionIds = React.useMemo(
    () =>
      new Set(
        manifest.actions.flatMap((action) =>
          action.interaction.type === "signed" &&
          action.interaction.resolves_attention
            ? [action.id]
            : [],
        ),
      ),
    [manifest.actions],
  );
  const actionUnavailableReasons = React.useMemo(
    () =>
      approvalInputs && !approvalInputs.ok
        ? new Map(
            manifest.actions.map((action) => [
              action.id,
              approvalInputs.reason,
            ]),
          )
        : undefined,
    [approvalInputs, manifest.actions],
  );
  const trusted = trust !== "untrusted";

  const submitSigned = React.useCallback(
    async (interaction: BlockSignedInteraction, input: unknown = {}) => {
      setActionError(null);
      setActionNotice(null);
      const declaration = manifest.actions.find(
        (candidate) => candidate.id === interaction.action_id,
      );
      if (
        declaration?.interaction.type !== "signed" ||
        declaration.interaction.resolves_attention !==
          Boolean(interaction.resolves_attention)
      ) {
        setActionError("This action is not declared by the pinned view.");
        return;
      }
      let currentInput = input;
      if (manifest.handle === "approval") {
        const currentApprovalInput = resolveApprovalActionInputForSubmission(
          data,
          interaction.action_id,
          Math.floor(Date.now() / 1000),
        );
        if (!currentApprovalInput.ok) {
          setActionError(currentApprovalInput.reason);
          return;
        }
        currentInput = currentApprovalInput.input;
      }
      const validatedInput = validateBlockActionData(
        manifest,
        interaction.action_id,
        currentInput,
      );
      if (!validatedInput.ok) {
        setActionError(validatedInput.message);
        return;
      }
      const channelId = exactChannelId(message.tags);
      if (!channelId || !instance.processorPubkey) {
        setActionError(
          "This action has no valid channel or responsible agent.",
        );
        return;
      }
      const idempotencyKey = crypto.randomUUID();
      try {
        await submitBlockAction({
          actionId: interaction.action_id,
          channelId,
          data: validatedInput.value,
          instanceEventId: message.id,
          instanceId: instance.instanceId,
          manifestId: instance.manifestId,
          processorPubkey: instance.processorPubkey,
          idempotencyKey,
        });
      } catch (error) {
        if (
          questionActionIds.has(interaction.action_id) &&
          queueScope &&
          queueRetryableQuestionAction(error, {
            ...queueScope,
            actionId: interaction.action_id,
            channelId,
            data: validatedInput.value,
            idempotencyKey,
            instanceEventId: message.id,
            instanceId: instance.instanceId,
            manifestId: instance.manifestId,
            processorPubkey: instance.processorPubkey,
            queuedAt: Date.now(),
          })
        ) {
          setActionNotice(
            "Saved offline. This answer will send when the conversation reconnects.",
          );
          return;
        }
        setActionError(
          error instanceof Error
            ? error.message
            : "The action could not be submitted.",
        );
      }
    },
    [
      data,
      instance,
      manifest,
      message.id,
      message.tags,
      questionActionIds,
      queueScope,
    ],
  );

  const openPresentation = React.useCallback(
    async (interaction: BlockPresentationInteraction) => {
      setActionError(null);
      setActionNotice(null);
      const declared = manifest.actions.some(
        (action) =>
          action.interaction.type === "presentation" &&
          action.interaction.surface === interaction.surface,
      );
      if (
        trust !== "core" ||
        !declared ||
        interaction.surface !== "agent-review" ||
        manifest.handle !== "agent-proposal"
      ) {
        setActionError("This local review surface is not available.");
        return;
      }
      const proposal = parseAgentProposalData(data, instance.instanceId);
      const channelId = exactChannelId(message.tags);
      const signerPubkey = message.signerPubkey?.toLowerCase() ?? "";
      const sourceEvent = message.blockEvent;
      if (
        !proposal ||
        !channelId ||
        proposal.channelId !== channelId ||
        !sourceEvent ||
        sourceEvent.id !== message.id ||
        sourceEvent.pubkey.toLowerCase() !== signerPubkey ||
        !instance.processorPubkey
      ) {
        setActionError("This Agent Proposal could not be verified for review.");
        return;
      }
      openAgentProposalReview({
        event: sourceEvent,
        channelId,
        signerPubkey,
        manifestId: instance.manifestId,
        instanceId: instance.instanceId,
        processorPubkey: instance.processorPubkey,
        data: proposal,
      });
    },
    [data, instance, manifest, message, trust],
  );

  const value = React.useMemo<BlockRenderContextValue>(
    () => ({
      actionError,
      actionNotice,
      attentionResolution,
      actionEnvironment: {
        origin: trust,
        trusted,
        declaredActionIds,
        directActionIds,
        directActionInputs: approvalInputs?.ok
          ? approvalInputs.inputs
          : undefined,
        actionUnavailableReasons,
        hideIndirectSignedActions: manifest.handle === "agent-proposal",
        resolvingActionIds,
        pendingActionId,
        completedActionIds,
        disabledReason: trusted
          ? undefined
          : "Actions are disabled because this publisher is not trusted.",
        submitSigned,
        openPresentation,
      },
    }),
    [
      actionError,
      actionNotice,
      attentionResolution,
      actionUnavailableReasons,
      completedActionIds,
      declaredActionIds,
      directActionIds,
      approvalInputs,
      resolvingActionIds,
      openPresentation,
      pendingActionId,
      submitSigned,
      trust,
      trusted,
      manifest.handle,
    ],
  );

  return (
    <BlockRenderContext.Provider value={value}>
      {children}
    </BlockRenderContext.Provider>
  );
}

export function useBlockRenderContext(): BlockRenderContextValue {
  const value = React.useContext(BlockRenderContext);
  if (!value) {
    throw new Error("Block renderer must be inside BlockRenderProvider");
  }
  return value;
}
