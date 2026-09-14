import type { UseMentionSendFlowOptions } from "./useMentionSendFlow.types";
import * as React from "react";
import { validateReplyModelRecipient } from "@/features/agents/lib/replyModelSelection";
import { toast } from "sonner";
import {
  useAttachManagedAgentToChannelMutation,
  useAvailableAcpRuntimes,
  useCreateChannelManagedAgentMutation,
  useManagedAgentsQuery,
  usePersonasQuery,
  useProvisionChannelManagedAgentMutation,
  useStartManagedAgentMutation,
} from "@/features/agents/hooks";
import { applyReusableAgentAccessPolicy } from "@/features/agents/channelAgents";
import { createMentionedPersonaAgentsWith } from "./useMentionSendFlow.personaAgents";
import { useAddChannelMembersMutation } from "@/features/channels/hooks";
import { useCanAddChannelMembers } from "@/features/channels/useCanAddChannelMembers";
import { PRIVATE_CHANNEL_ADD_DENIED_MESSAGE } from "@/features/channels/lib/channelMemberAdmission";
import { dmThreadAgentMentionError } from "@/features/messages/lib/dmThreadAgentMentionError";
import { filterEffectiveExplicitAgentPubkeys } from "@/features/messages/lib/effectiveExplicitAgentPubkeys";
import {
  prepareBackgroundMediaUpload,
  saveQueuedAttachmentsForDraft,
} from "@/features/messages/lib/backgroundMediaUploadStore";
import {
  buildOutgoingMessage,
  type ImetaMedia,
} from "@/features/messages/lib/imetaMediaMarkdown";
import { invokeTauri } from "@/shared/api/tauri";
import { useComposerNewTask } from "./useComposerNewTask";
import type { AcpRuntime, ManagedAgent } from "@/shared/api/types";
import { normalizePubkey, truncateNpub } from "@/shared/lib/pubkey";
import {
  attachOutgoingWorkContext,
  buildTypedMentionRouting,
  createFinishSendFailureHandler,
  getErrorMessage,
  isManagedAgentRunning,
  isProviderBackedAgent,
  MENTION_REFERENCE_TAG,
  mergeOutgoingTagsWithReferenceMentions,
  nonMemberMentionPubkeys,
  type PendingNonMemberMentionSend,
  persistCanceledDraftIfUnchanged,
  runReportingFinishSendFailures,
  type SendMessageWithMentionFlowInput,
  mentionRevalidationOptions,
  uniqueNormalizedPubkeys,
} from "./useMentionSendFlow.helpers";

export function useMentionSendFlow({
  channelId,
  channelLinks,
  channelType,
  contentRef,
  customEmoji,
  drafts,
  emojiAutocomplete,
  mentions,
  onPrepareSendChannel,
  onSendRef,
  richText,
  setContent,
  setIsEmojiPickerOpen,
  setPendingImeta,
  hasUnsavedMedia,
  clearQueuedAttachments,
  restoreQueuedAttachments,
  setSpoileredAttachmentUrls,
  onSuccessfulExplicitAgentAudience,
  onReplyModelSent,
  onReplyModelRestored,
  resolvePostSendContent,
  threadRootId = null,
}: UseMentionSendFlowOptions) {
  const newTask = useComposerNewTask(channelId, channelType, threadRootId);
  const [pendingNonMemberSend, setPendingNonMemberSend] =
    React.useState<PendingNonMemberMentionSend | null>(null);
  const [nonMemberPromptError, setNonMemberPromptError] = React.useState<
    string | null
  >(null);
  const [isMentionSendPending, setIsMentionSendPending] = React.useState(false);
  const [isCompleteSendPending, setIsCompleteSendPending] =
    React.useState(false);
  const isMentionSendPendingRef = React.useRef(false);
  const isCompleteSendPendingRef = React.useRef(false);
  const isMountedRef = React.useRef(false);
  const previousChannelIdRef = React.useRef(channelId);
  // Tracks the live channel so completeSend can ask "is the user still here?"
  // without being frozen to the compose-time closure.
  const channelIdRef = React.useRef(channelId);
  channelIdRef.current = channelId;
  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const addMembersMutation = useAddChannelMembersMutation(channelId);
  const canInviteNonMembers = useCanAddChannelMembers(channelId);
  const attachAgentMutation = useAttachManagedAgentToChannelMutation(channelId);
  const createPersonaAgentMutation =
    useCreateChannelManagedAgentMutation(channelId);
  const provisionPersonaAgentMutation =
    useProvisionChannelManagedAgentMutation(channelId);
  const availableRuntimesQuery = useAvailableAcpRuntimes();
  const managedAgentsQuery = useManagedAgentsQuery();
  const personasQuery = usePersonasQuery();
  const startAgentMutation = useStartManagedAgentMutation();
  const getManagedAgentsByPubkey = React.useCallback(async () => {
    const agents =
      managedAgentsQuery.data ??
      (await managedAgentsQuery.refetch()).data ??
      [];
    return new Map(
      agents.map((agent) => [normalizePubkey(agent.pubkey), agent]),
    );
  }, [managedAgentsQuery.data, managedAgentsQuery.refetch]);
  const getPersonas = React.useCallback(async () => {
    return personasQuery.data ?? (await personasQuery.refetch()).data ?? [];
  }, [personasQuery.data, personasQuery.refetch]);
  const getAvailableRuntimes = React.useCallback(async (): Promise<
    AcpRuntime[]
  > => {
    const cached = availableRuntimesQuery.data ?? [];
    if (cached.length > 0 || !availableRuntimesQuery.isLoading) {
      return cached;
    }
    const refetched = await availableRuntimesQuery.refetch();
    return (refetched.data ?? []).filter(
      (runtime): runtime is AcpRuntime =>
        runtime.availability === "available" &&
        runtime.command !== null &&
        runtime.binaryPath !== null,
    );
  }, [
    availableRuntimesQuery.data,
    availableRuntimesQuery.isLoading,
    availableRuntimesQuery.refetch,
  ]);
  const ensureManagedAgentMentionsReady = React.useCallback(
    async (
      mentionPubkeys: string[],
      capturedChannelId: string,
      preparedParticipantPubkeys: string[] = [],
      preparedManagedAgents: ManagedAgent[] = [],
    ) => {
      if (!capturedChannelId || mentionPubkeys.length === 0) {
        return {
          errors: [] as string[],
          pubkeys: [] as string[],
        };
      }
      const [managedAgentsByPubkey, personas] = await Promise.all([
        getManagedAgentsByPubkey(),
        getPersonas(),
      ]);
      for (const agent of preparedManagedAgents) {
        managedAgentsByPubkey.set(normalizePubkey(agent.pubkey), agent);
      }
      const existingMembers = new Set(
        [...mentions.memberPubkeys].map(normalizePubkey),
      );
      const participants = new Set([
        ...existingMembers,
        ...preparedParticipantPubkeys.map(normalizePubkey),
      ]);
      const errors: string[] = [];
      const pubkeys: string[] = [];
      for (const pubkey of uniqueNormalizedPubkeys(mentionPubkeys)) {
        const agent = managedAgentsByPubkey.get(pubkey);
        if (!agent) continue;
        try {
          const readyAgent = existingMembers.has(pubkey)
            ? agent
            : await applyReusableAgentAccessPolicy(
                agent,
                {},
                personas.find((persona) => persona.id === agent.personaId),
              );
          if (participants.has(pubkey)) {
            if (
              (isProviderBackedAgent(readyAgent) &&
                readyAgent.status !== "deployed") ||
              (!isProviderBackedAgent(readyAgent) &&
                !isManagedAgentRunning(readyAgent))
            ) {
              await startAgentMutation.mutateAsync(readyAgent.pubkey);
            }
          } else {
            await attachAgentMutation.mutateAsync({
              channelId: capturedChannelId,
              agent: readyAgent,
              role: "bot",
            });
          }
          pubkeys.push(pubkey);
        } catch (error) {
          errors.push(
            `${agent.name}: ${getErrorMessage(error, "Could not prepare agent.")}`,
          );
        }
      }
      return { errors, pubkeys: uniqueNormalizedPubkeys(pubkeys) };
    },
    [
      attachAgentMutation,
      getManagedAgentsByPubkey,
      getPersonas,
      mentions.memberPubkeys,
      startAgentMutation,
    ],
  );
  const createMentionedPersonaAgents = React.useCallback(
    (trimmed: string, capturedChannelId: string) =>
      createMentionedPersonaAgentsWith(trimmed, capturedChannelId, {
        channelType,
        createPersonaAgentMutation,
        extractMentionPersonas: mentions.extractMentionPersonas,
        getAvailableRuntimes,
        onPrepareSendChannel,
        provisionPersonaAgentMutation,
        registerMentionPubkey: mentions.registerMentionPubkey,
      }),
    [
      createPersonaAgentMutation,
      channelType,
      getAvailableRuntimes,
      mentions.extractMentionPersonas,
      mentions.registerMentionPubkey,
      onPrepareSendChannel,
      provisionPersonaAgentMutation,
    ],
  );

  const clearComposer = React.useCallback(
    (postSendContent = "") => {
      setPendingNonMemberSend(null);
      setNonMemberPromptError(null);
      setContent(postSendContent);
      contentRef.current = postSendContent;
      if (postSendContent) {
        richText.restorePlainTextAndFocusEnd(postSendContent);
        mentions.cancelMentionAutocomplete();
      } else richText.clearContent();
      setPendingImeta([]);
      clearQueuedAttachments();
      setSpoileredAttachmentUrls?.(new Set());
      if (!postSendContent) mentions.clearMentions();
      channelLinks.clearChannels();
      emojiAutocomplete.clearEmojis();
      setIsEmojiPickerOpen(false);
    },
    [
      channelLinks.clearChannels,
      contentRef,
      emojiAutocomplete.clearEmojis,
      mentions.cancelMentionAutocomplete,
      mentions.clearMentions,
      richText.clearContent,
      richText.restorePlainTextAndFocusEnd,
      setContent,
      setIsEmojiPickerOpen,
      setPendingImeta,
      clearQueuedAttachments,
      setSpoileredAttachmentUrls,
    ],
  );

  React.useEffect(() => {
    if (previousChannelIdRef.current === channelId) {
      return;
    }

    previousChannelIdRef.current = channelId;
    setPendingNonMemberSend(null);
    setNonMemberPromptError(null);
  }, [channelId]);

  const completeSend = React.useCallback(
    async (
      draft: PendingNonMemberMentionSend,
      mentionPubkeys: string[],
      outgoingTags = draft.outgoingTags,
    ) => {
      if (isCompleteSendPendingRef.current) {
        return;
      }

      isCompleteSendPendingRef.current = true;
      setIsCompleteSendPending(true);
      const preparedUpload =
        draft.queuedAttachments.length > 0
          ? prepareBackgroundMediaUpload(draft.queuedAttachments)
          : null;
      const persistPreflightDraft = () => {
        if (!draft.recoveryDraftKey) return;
        drafts.persistDraft(
          draft.recoveryDraftKey,
          draft.savedContent,
          draft.capturedChannelId ?? draft.recoveryDraftKey,
          draft.savedImeta,
          [...draft.savedSpoileredAttachmentUrls],
          draft.savedMentionRefs,
        );
        saveQueuedAttachmentsForDraft(
          draft.recoveryDraftKey,
          draft.queuedAttachments,
        );
      };
      let uploadStarted = false;
      try {
        let admittedMentionPubkeys: string[];
        try {
          admittedMentionPubkeys = uniqueNormalizedPubkeys(
            await mentions.revalidateMentionPubkeys(
              mentionPubkeys,
              draft.capturedChannelId,
              mentionRevalidationOptions(draft, "prepare"),
            ),
          );
        } catch (error) {
          // A mention revoked between selection and send fails the send and
          // says so, rather than rejecting into the click handler unseen. The
          // composer is still untouched here, so the draft stays put.
          persistCanceledDraftIfUnchanged(draft, drafts);
          toast.error(getErrorMessage(error, "The message could not be sent."));
          return;
        }
        if (!isMountedRef.current) return persistPreflightDraft();
        const admittedMentionPubkeySet = new Set(admittedMentionPubkeys);
        const readyAgentPubkeys = new Set(
          uniqueNormalizedPubkeys(draft.readyAgentPubkeys ?? []).filter(
            (pubkey) => admittedMentionPubkeySet.has(pubkey),
          ),
        );
        const managedAgentsByPubkey = await getManagedAgentsByPubkey();
        if (!isMountedRef.current) {
          persistPreflightDraft();
          return;
        }
        for (const agent of draft.preparedManagedAgents ?? []) {
          managedAgentsByPubkey.set(normalizePubkey(agent.pubkey), agent);
        }
        const normalizedMentionPubkeys = admittedMentionPubkeys;
        const managedMentionPubkeys = normalizedMentionPubkeys.filter(
          (pubkey) => managedAgentsByPubkey.has(pubkey),
        );
        const agentMentionPubkeys = uniqueNormalizedPubkeys([
          ...managedMentionPubkeys,
          ...normalizedMentionPubkeys.filter(mentions.isAgentPubkey),
        ]);
        const preparedAgentPubkeys = uniqueNormalizedPubkeys([
          ...readyAgentPubkeys,
          ...agentMentionPubkeys,
        ]);
        let sendChannelId = draft.capturedChannelId;
        if (preparedAgentPubkeys.length > 0 && onPrepareSendChannel) {
          sendChannelId = await onPrepareSendChannel(preparedAgentPubkeys);
          if (!sendChannelId) {
            return;
          }
          if (!isMountedRef.current) {
            persistPreflightDraft();
            return;
          }
        }

        const agentReadiness = await ensureManagedAgentMentionsReady(
          managedMentionPubkeys.filter(
            (pubkey) => !readyAgentPubkeys.has(normalizePubkey(pubkey)),
          ),
          sendChannelId ?? "",
          onPrepareSendChannel ? preparedAgentPubkeys : [],
          [...managedAgentsByPubkey.values()],
        );
        if (!isMountedRef.current) {
          persistPreflightDraft();
          return;
        }
        if (agentReadiness.errors.length > 0) {
          const message =
            agentReadiness.errors.length === 1
              ? `Could not start agent mention: ${agentReadiness.errors[0]}`
              : `Could not start agent mentions: ${agentReadiness.errors.join(
                  "; ",
                )}`;
          setNonMemberPromptError(message);
          toast.error(message);
          return;
        }
        if (preparedAgentPubkeys.length > 0 && sendChannelId) {
          try {
            await invokeTauri("sync_agents_to_active_huddle", {
              channelId: sendChannelId,
              agentPubkeys: preparedAgentPubkeys,
            });
          } catch (error) {
            const message = `Could not add mentioned agent to the Huddle: ${getErrorMessage(
              error,
              "Huddle enrollment failed.",
            )}`;
            setNonMemberPromptError(message);
            toast.error(message);
            return;
          }
        }
        const effectiveExplicitAgentPubkeys =
          filterEffectiveExplicitAgentPubkeys(
            draft.explicitAgentPubkeys,
            mentionPubkeys,
          );
        const send = onSendRef.current;
        const persistCanceledDraft = () =>
          persistCanceledDraftIfUnchanged(draft, drafts);
        const restoreComposerAfterFailure = () => {
          persistCanceledDraft();
          const canRestoreCurrentComposer =
            isMountedRef.current &&
            (draft.capturedChannelId === channelIdRef.current ||
              channelIdRef.current === null) &&
            contentRef.current.trim().length === 0 &&
            !hasUnsavedMedia();
          if (!canRestoreCurrentComposer && draft.recoveryDraftKey) {
            saveQueuedAttachmentsForDraft(
              draft.recoveryDraftKey,
              draft.queuedAttachments,
            );
          }
          if (!canRestoreCurrentComposer) {
            return;
          }
          setContent(draft.savedContent);
          contentRef.current = draft.savedContent;
          richText.setContent(draft.savedContent);
          setPendingImeta(draft.savedImeta);
          restoreQueuedAttachments(draft.queuedAttachments);
          mentions.restoreDraftMentionRefs(draft.savedMentionRefs);
          const replyTag = outgoingTags?.find(
            (tag) => tag[0] === "agent-reply",
          );
          if (replyTag) onReplyModelRestored?.(replyTag);
          setSpoileredAttachmentUrls?.(
            new Set(draft.savedSpoileredAttachmentUrls),
          );
        };
        const handleFinishSendFailure = createFinishSendFailureHandler(
          restoreComposerAfterFailure,
        );
        const finishSend = async (
          uploaded: ImetaMedia[],
          signal?: AbortSignal,
        ) => {
          const { content: finalContent, mediaTags } = buildOutgoingMessage(
            draft.trimmed,
            [...draft.savedImeta, ...uploaded],
            new Set([
              ...draft.savedSpoileredAttachmentUrls,
              ...draft.queuedAttachments.flatMap((attachment, index) =>
                attachment.spoilered && uploaded[index]
                  ? [uploaded[index].url]
                  : [],
              ),
            ]),
          );
          // Toasts here rather than at the outer catch so the attach
          // failure's own message survives; the outer catch reports
          // everything after it, which used to be reported nowhere at all.
          let finalOutgoingTags: string[][] | undefined;
          try {
            validateReplyModelRecipient(outgoingTags, agentMentionPubkeys);
            finalOutgoingTags = await attachOutgoingWorkContext({
              channelId: sendChannelId ?? draft.capturedChannelId ?? "",
              content: finalContent,
              agentPubkeys: agentMentionPubkeys,
              mediaTags,
              outgoingTags,
              threadContext: draft.capturedThreadContext,
              channelType,
              newTask: newTask.isRequested(),
              threadHasOpenTask: newTask.hasOpenTask,
            });
          } catch (error) {
            handleFinishSendFailure(error);
            return;
          }
          if (signal?.aborted) return;
          // The pass immediately before signing and publish is always fresh:
          // mention authorization is re-validated here unconditionally,
          // whatever did or did not separate it from the admission pass
          // above (#5681), and bounded to this destination and this mention
          // set for remote agents (#6224).
          const revalidatedMentionPubkeys =
            await mentions.revalidateMentionPubkeys(
              mentionPubkeys,
              sendChannelId ?? draft.capturedChannelId,
              mentionRevalidationOptions(
                draft,
                "publish",
                preparedAgentPubkeys,
              ),
            );
          if (signal?.aborted) return;
          const revalidatedExplicitAgentPubkeys =
            filterEffectiveExplicitAgentPubkeys(
              draft.explicitAgentPubkeys,
              revalidatedMentionPubkeys,
            );
          await send(
            finalContent,
            revalidatedMentionPubkeys,
            finalOutgoingTags,
            sendChannelId,
            draft.capturedThreadContext,
          );
          if (signal?.aborted) return;
          newTask.afterSend(); // Per-send, not a mode.
          const replyTag = finalOutgoingTags?.find(
            (tag) => tag[0] === "agent-reply",
          );
          if (replyTag) onReplyModelSent?.(replyTag);
          // Promote only agents that survived REVALIDATION for this send, not
          // the ones that were merely effective when the draft was composed.
          // "Send without inviting" removes its excluded recipients here as
          // well as from event routing.
          if (revalidatedExplicitAgentPubkeys.length > 0) {
            onSuccessfulExplicitAgentAudience?.({
              channelId: sendChannelId ?? draft.capturedChannelId ?? "",
              expectedGeneration: draft.audienceGeneration,
              expectedRevision: draft.audienceRevision,
              explicitAgentPubkeys: revalidatedExplicitAgentPubkeys,
            });
          }
          if (draft.sentDraftKey) {
            drafts.markDraftSent(
              draft.sentDraftKey,
              draft.savedContent,
              draft.capturedChannelId ?? draft.sentDraftKey,
              draft.savedImeta,
              [...draft.savedSpoileredAttachmentUrls],
            );
          }
        };
        if (preparedUpload) {
          uploadStarted = preparedUpload.start({
            onComplete: async (uploaded, signal) => {
              await runReportingFinishSendFailures(
                () => finishSend(uploaded, signal),
                handleFinishSendFailure,
              );
            },
            onError: (error) => {
              restoreComposerAfterFailure();
              toast.error(
                `Upload failed: ${getErrorMessage(error, "Unknown error")}`,
              );
            },
            onCancel: () => {
              restoreComposerAfterFailure();
            },
          });
          if (!uploadStarted) {
            return;
          }
        }
        // Replace the sent body directly with its final post-send state before
        // the async network send starts. This avoids an intermediate blank frame
        // for persistent audiences while preserving the ordinary empty state.
        if (
          draft.capturedChannelId === channelIdRef.current ||
          channelIdRef.current === null
        ) {
          clearComposer(
            resolvePostSendContent?.(effectiveExplicitAgentPubkeys),
          );
        }

        if (!preparedUpload) {
          await runReportingFinishSendFailures(
            () => finishSend([]),
            handleFinishSendFailure,
          );
        }
      } finally {
        if (!uploadStarted) preparedUpload?.cancel();
        isCompleteSendPendingRef.current = false;
        if (isMountedRef.current) {
          setIsCompleteSendPending(false);
        }
      }
    },
    [
      channelType,
      clearComposer,
      contentRef,
      drafts,
      newTask.afterSend,
      newTask.hasOpenTask,
      newTask.isRequested,
      ensureManagedAgentMentionsReady,
      getManagedAgentsByPubkey,
      mentions.isAgentPubkey,
      mentions.revalidateMentionPubkeys,
      onPrepareSendChannel,
      onSendRef,
      onSuccessfulExplicitAgentAudience,
      onReplyModelSent,
      onReplyModelRestored,
      resolvePostSendContent,
      richText.setContent,
      setContent,
      setPendingImeta,
      restoreQueuedAttachments,
      setSpoileredAttachmentUrls,
      hasUnsavedMedia,
      mentions.restoreDraftMentionRefs,
    ],
  );

  const getNonMemberMentionPubkeys = React.useCallback(
    (pubkeys: string[]) =>
      nonMemberMentionPubkeys({
        pubkeys,
        channelType,
        hasResolvedMembers: mentions.hasResolvedMembers,
        memberPubkeys: mentions.memberPubkeys,
      }),
    [channelType, mentions.hasResolvedMembers, mentions.memberPubkeys],
  );

  const getDmThreadAgentMentionError = React.useCallback(
    (
      trimmed: string,
      capturedThreadContext: SendMessageWithMentionFlowInput["capturedThreadContext"],
    ) =>
      dmThreadAgentMentionError({
        trimmed,
        isThreadReply: capturedThreadContext != null,
        channelType,
        extractMentionPersonas: mentions.extractMentionPersonas,
        extractMentionPubkeys: mentions.extractMentionPubkeys,
        isAgentPubkey: mentions.isAgentPubkey,
        hasResolvedMembers: mentions.hasResolvedMembers,
        memberPubkeys: mentions.memberPubkeys,
      }),
    [
      channelType,
      mentions.extractMentionPersonas,
      mentions.extractMentionPubkeys,
      mentions.hasResolvedMembers,
      mentions.isAgentPubkey,
      mentions.memberPubkeys,
    ],
  );
  const sendMessageWithMentionFlow = React.useCallback(
    async ({
      capturedChannelId,
      capturedThreadContext = null,
      pendingImeta,
      queuedAttachments = [],
      linkPreviewTags = [],
      replyModelTag,
      sentDraftKey,
      recoveryDraftKey,
      spoileredAttachmentUrls = new Set(),
      trimmed,
      audienceGeneration = 0,
      audienceRevision = null,
    }: SendMessageWithMentionFlowInput) => {
      if (isMentionSendPendingRef.current) {
        return;
      }
      isMentionSendPendingRef.current = true;
      setIsMentionSendPending(true);
      try {
        // Every extraction below reads the mention map, and a pasted identity
        // can still be verifying — the relay round trip for a non-member is
        // exactly the case this feature exists for. Sending first would
        // publish a readable `@Label` with no `p` tag. Bounded inside, so a
        // lookup that never answers delays the send rather than blocking it.
        await mentions.settlePendingMentionBindings();
        const dmThreadAgentMentionError = getDmThreadAgentMentionError(
          trimmed,
          capturedThreadContext,
        );
        if (dmThreadAgentMentionError) {
          setNonMemberPromptError(dmThreadAgentMentionError);
          toast.error(dmThreadAgentMentionError);
          return;
        }
        let effectiveChannelId = capturedChannelId;
        if (!effectiveChannelId && onPrepareSendChannel) {
          effectiveChannelId = await onPrepareSendChannel();
          if (!effectiveChannelId) {
            return;
          }
        }
        const personaMentionResult = await createMentionedPersonaAgents(
          trimmed,
          effectiveChannelId ?? "",
        );
        if (personaMentionResult.errors.length > 0) {
          const message =
            personaMentionResult.errors.length === 1
              ? `Could not create agent mention: ${personaMentionResult.errors[0]}`
              : `Could not create agent mentions: ${personaMentionResult.errors.join(
                  "; ",
                )}`;
          setNonMemberPromptError(message);
          toast.error(message);
          return;
        }

        const createdPersonaAgentPubkeys = personaMentionResult.pubkeys;
        const createdPersonaAgentPubkeySet = new Set(
          createdPersonaAgentPubkeys.map(normalizePubkey),
        );
        const { actorPubkeys: explicitMentionPubkeys, outgoingTags } =
          buildTypedMentionRouting({
            content: trimmed,
            createdPersonaAgentPubkeys,
            customEmoji,
            linkPreviewTags,
            mentionPubkeys: mentions.extractMentionPubkeys(trimmed),
            pendingImeta,
            routeTypedMentionReferences: mentions.routeTypedMentionReferences,
            spoileredAttachmentUrls,
          });
        const explicitAgentPubkeys = explicitMentionPubkeys.filter(
          (pubkey) =>
            mentions.isAgentPubkey(pubkey) ||
            createdPersonaAgentPubkeySet.has(pubkey),
        );
        const pubkeys = explicitMentionPubkeys;
        const nonMemberPubkeys = getNonMemberMentionPubkeys(pubkeys);
        let promptNonMemberPubkeys = nonMemberPubkeys.filter(
          (pubkey) =>
            !mentions.isManagedAgentPubkey(pubkey) &&
            !createdPersonaAgentPubkeySet.has(normalizePubkey(pubkey)),
        );

        if (promptNonMemberPubkeys.length > 0) {
          try {
            const managedAgentsByPubkey = await getManagedAgentsByPubkey();
            promptNonMemberPubkeys = promptNonMemberPubkeys.filter(
              (pubkey) => !managedAgentsByPubkey.has(normalizePubkey(pubkey)),
            );
          } catch {
            // Keep the hook-based managed-agent filtering even if the query
            // fallback misses; ordinary non-members still get prompted.
          }
        }

        const pendingDraft: PendingNonMemberMentionSend = {
          capturedChannelId: effectiveChannelId,
          capturedThreadContext,
          trimmed,
          mentionPubkeys: pubkeys,
          nonMemberPubkeys: promptNonMemberPubkeys,
          outgoingTags: replyModelTag
            ? [...(outgoingTags ?? []), replyModelTag]
            : outgoingTags,
          preparedManagedAgents: personaMentionResult.agents,
          readyAgentPubkeys:
            channelType === "dm" && onPrepareSendChannel
              ? []
              : createdPersonaAgentPubkeys,
          savedContent: trimmed,
          savedImeta: [...pendingImeta],
          queuedAttachments: [...queuedAttachments],
          savedSpoileredAttachmentUrls: new Set(spoileredAttachmentUrls),
          sentDraftKey,
          recoveryDraftKey,
          savedMentionRefs: mentions.getDraftMentionRefs(trimmed),
          audienceGeneration,
          audienceRevision,
          explicitAgentPubkeys,
        };

        if (promptNonMemberPubkeys.length > 0) {
          // Authorization precedes every relay side effect, the invite
          // included: a mention revoked between selection and send must fail
          // the send rather than open a prompt that would add the agent to the
          // channel first (#6224, #7124).
          try {
            await mentions.revalidateMentionPubkeys(
              pubkeys,
              effectiveChannelId,
              mentionRevalidationOptions(pendingDraft, "prepare"),
            );
          } catch (error) {
            // The composer has not been cleared yet on this path, so the draft
            // simply stays where the user left it.
            toast.error(
              getErrorMessage(error, "The message could not be sent."),
            );
            return;
          }
          setNonMemberPromptError(null);
          setPendingNonMemberSend(pendingDraft);
          return;
        }

        await completeSend(pendingDraft, pubkeys);
      } catch (error) {
        toast.error(
          getErrorMessage(error, "Could not prepare mentions. Please retry."),
        );
      } finally {
        isMentionSendPendingRef.current = false;
        setIsMentionSendPending(false);
      }
    },
    [
      completeSend,
      channelType,
      createMentionedPersonaAgents,
      customEmoji,
      getManagedAgentsByPubkey,
      getNonMemberMentionPubkeys,
      getDmThreadAgentMentionError,
      mentions.extractMentionPubkeys,
      mentions.revalidateMentionPubkeys,
      mentions.isAgentPubkey,
      mentions.isManagedAgentPubkey,
      mentions.getDraftMentionRefs,
      mentions.routeTypedMentionReferences,
      mentions.settlePendingMentionBindings,
      onPrepareSendChannel,
    ],
  );

  const pendingNonMemberNames = React.useMemo(() => {
    if (!pendingNonMemberSend) return [];

    return pendingNonMemberSend.nonMemberPubkeys.map(
      (pubkey) =>
        mentions.getMentionDisplayName(pubkey) ?? truncateNpub(pubkey),
    );
  }, [mentions.getMentionDisplayName, pendingNonMemberSend]);

  const handleSendWithoutInviting = React.useCallback(() => {
    if (!pendingNonMemberSend) return;

    const nonMemberPubkeys = new Set(
      pendingNonMemberSend.nonMemberPubkeys.map((pubkey) =>
        normalizePubkey(pubkey),
      ),
    );
    const mentionPubkeys = pendingNonMemberSend.mentionPubkeys.filter(
      (pubkey) => !nonMemberPubkeys.has(normalizePubkey(pubkey)),
    );
    const outgoingTags = mergeOutgoingTagsWithReferenceMentions(
      pendingNonMemberSend.outgoingTags,
      nonMemberPubkeys,
    );
    void completeSend(pendingNonMemberSend, mentionPubkeys, outgoingTags);
  }, [completeSend, pendingNonMemberSend]);
  const handleInviteNonMembers = React.useCallback(() => {
    if (!pendingNonMemberSend) return;
    if (!canInviteNonMembers) {
      setNonMemberPromptError(PRIVATE_CHANNEL_ADD_DENIED_MESSAGE);
      return;
    }
    setNonMemberPromptError(null);
    void (async () => {
      const mentionPubkeys = uniqueNormalizedPubkeys(
        await mentions.revalidateMentionPubkeys([
          ...pendingNonMemberSend.mentionPubkeys,
          ...pendingNonMemberSend.nonMemberPubkeys,
        ]),
      );
      const admittedMentionPubkeys = new Set(mentionPubkeys);
      const originalNonMemberPubkeys = new Set(
        pendingNonMemberSend.nonMemberPubkeys.map(normalizePubkey),
      );
      const nonMemberPubkeys = [...originalNonMemberPubkeys].filter(
        admittedMentionPubkeys.has.bind(admittedMentionPubkeys),
      );
      const outgoingTags = (pendingNonMemberSend.outgoingTags ?? []).filter(
        (tag) =>
          tag[0] !== MENTION_REFERENCE_TAG ||
          !originalNonMemberPubkeys.has(normalizePubkey(tag[1] ?? "")),
      );
      const managedAgentsByPubkey = await getManagedAgentsByPubkey();
      if (!isMountedRef.current) return;
      const peoplePubkeys: string[] = [];
      const relayAgentPubkeys: string[] = [];
      for (const pubkey of nonMemberPubkeys) {
        if (managedAgentsByPubkey.has(pubkey)) {
          continue;
        }

        if (mentions.isAgentPubkey(pubkey)) {
          relayAgentPubkeys.push(pubkey);
        } else {
          peoplePubkeys.push(pubkey);
        }
      }

      const errors: string[] = [];
      if (peoplePubkeys.length > 0) {
        const result = await addMembersMutation.mutateAsync({
          channelId: pendingNonMemberSend.capturedChannelId ?? undefined,
          pubkeys: peoplePubkeys,
          role: "member",
        });
        errors.push(...result.errors.map((error) => error.error));
      }

      if (relayAgentPubkeys.length > 0) {
        const result = await addMembersMutation.mutateAsync({
          channelId: pendingNonMemberSend.capturedChannelId ?? undefined,
          pubkeys: relayAgentPubkeys,
          role: "bot",
        });
        errors.push(...result.errors.map((error) => error.error));
      }

      if (errors.length > 0) {
        setNonMemberPromptError(errors.join("; "));
        return;
      }

      await completeSend(
        {
          ...pendingNonMemberSend,
          mentionPubkeys,
          outgoingTags,
        },
        mentionPubkeys,
        outgoingTags,
      );
    })().catch((error) => {
      setNonMemberPromptError(
        error instanceof Error ? error.message : "Could not invite members.",
      );
    });
  }, [
    addMembersMutation,
    canInviteNonMembers,
    completeSend,
    getManagedAgentsByPubkey,
    mentions.isAgentPubkey,
    mentions.revalidateMentionPubkeys,
    pendingNonMemberSend,
  ]);

  const dismissNonMemberPrompt = React.useCallback(() => {
    setPendingNonMemberSend(null);
    setNonMemberPromptError(null);
  }, []);

  return {
    newTaskToggle: newTask.control,
    isPreparingMentionSend:
      isMentionSendPending ||
      isCompleteSendPending ||
      attachAgentMutation.isPending ||
      createPersonaAgentMutation.isPending ||
      startAgentMutation.isPending,
    /** Spread straight into `NonMemberMentionDialog`. */
    nonMemberPromptProps: {
      canInvite: canInviteNonMembers,
      error: nonMemberPromptError,
      isInvitePending:
        isMentionSendPending ||
        isCompleteSendPending ||
        addMembersMutation.isPending ||
        attachAgentMutation.isPending ||
        createPersonaAgentMutation.isPending ||
        startAgentMutation.isPending,
      names: pendingNonMemberNames,
      onDismiss: dismissNonMemberPrompt,
      onDoNothing: handleSendWithoutInviting,
      onInvite: handleInviteNonMembers,
      open: pendingNonMemberSend !== null,
    },
    sendMessageWithMentionFlow,
  };
}
