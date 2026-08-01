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
import { approveCompanyBlueprint } from "@/features/company/approveCompanyBlueprint";
import {
  isBlueprintApproval,
  readBlueprintApproval,
  resolveBlueprintActionInputs,
} from "@/features/company/blueprintApproval";
import {
  isInitiativeAction,
  readInitiativeCardAction,
  resolveInitiativeActionInputs,
} from "@/features/company/initiativeCard";
import { startInitiative } from "@/features/company/startInitiative";

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
  const blueprintInputs = React.useMemo(
    () =>
      manifest.handle === "company-blueprint"
        ? resolveBlueprintActionInputs(data)
        : new Map<string, Record<string, unknown>>(),
    [data, manifest.handle],
  );
  const initiativeInputs = React.useMemo(
    () =>
      manifest.handle === "initiative"
        ? resolveInitiativeActionInputs(data)
        : new Map<string, Record<string, unknown>>(),
    [data, manifest.handle],
  );
  const directActionInputs = React.useMemo(() => {
    const inputs = new Map<string, unknown>();
    if (approvalInputs?.ok) {
      for (const [actionId, input] of approvalInputs.inputs) {
        inputs.set(actionId, input);
      }
    }
    for (const [actionId, input] of blueprintInputs) {
      inputs.set(actionId, input);
    }
    for (const [actionId, input] of initiativeInputs) {
      inputs.set(actionId, input);
    }
    return inputs;
  }, [approvalInputs, blueprintInputs, initiativeInputs]);
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
    // An action that declares required inputs is still directly clickable when
    // those inputs are facts about the instance rather than questions for the
    // owner. Clickability follows from having them, so there is one place that
    // decides and the two cannot drift apart.
    for (const actionId of directActionInputs.keys()) {
      direct.add(actionId);
    }
    return direct;
  }, [directActionInputs, manifest.actions, manifest.handle]);
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
      const derivedBlueprintInput = blueprintInputs.get(interaction.action_id);
      if (derivedBlueprintInput) {
        currentInput = derivedBlueprintInput;
      }
      const derivedInitiativeInput = initiativeInputs.get(
        interaction.action_id,
      );
      if (derivedInitiativeInput) {
        currentInput = derivedInitiativeInput;
      }
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
      // Approving a Blueprint is the one Block action with a local effect: it
      // creates the company's employees and teams before anything is published.
      // It runs first, so a relay that refuses the record of the decision
      // cannot leave the owner with a company they were told was created.
      if (isBlueprintApproval(interaction.action_id)) {
        const approval = readBlueprintApproval(data);
        if (!approval) {
          setActionError(
            "This blueprint is missing the document it proposes. Ask for it again.",
          );
          return;
        }
        try {
          await approveCompanyBlueprint({ ...approval, channelId });
        } catch (error) {
          setActionError(
            error instanceof Error
              ? error.message
              : "The company could not be created.",
          );
          return;
        }
      }

      // Starting an initiative is the other Block action with a local effect:
      // it publishes the owner-signed company writes that approve it, activate
      // it, and create its first Task. Like Blueprint approval it runs first,
      // so a relay that refuses the record of the decision cannot leave the
      // owner believing work started when it did not.
      if (
        manifest.handle === "initiative" &&
        isInitiativeAction(interaction.action_id)
      ) {
        const request = readInitiativeCardAction(data, interaction.action_id);
        if (!request) {
          setActionError(
            "This card is missing the initiative it refers to. Ask for it again.",
          );
          return;
        }
        try {
          const outcome = await startInitiative(request);
          if (outcome.status === "blocked") {
            setActionError(outcome.message);
            return;
          }
          if (outcome.status === "settled") {
            setActionNotice(
              `This initiative is already ${outcome.initiativeStatus}.`,
            );
          }
        } catch (error) {
          setActionError(
            error instanceof Error
              ? error.message
              : "This initiative could not be started.",
          );
          return;
        }
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
      blueprintInputs,
      data,
      initiativeInputs,
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
        // Both maps matter and they are not the same thing: `directActionIds`
        // decides whether a control is clickable, `directActionInputs` is what
        // the click actually sends. A control listed in the first but missing
        // from the second is enabled and submits nothing.
        directActionInputs: directActionInputs.size
          ? directActionInputs
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
      directActionInputs,
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
