import { toast } from "sonner";
import type { ManagedAgent } from "@/shared/api/types";
import type { CustomEmoji } from "@/shared/lib/remarkCustomEmoji";
import { buildCustomEmojiTags } from "@/shared/lib/customEmojiTags";
import { buildOutgoingMessage } from "@/features/messages/lib/imetaMediaMarkdown";
import { attachWorkContext } from "@/features/company/attachWorkContext";
import { mergeOutgoingTags } from "@/features/messages/lib/imetaMediaMarkdown";
import type { ImetaMedia } from "@/features/messages/lib/imetaMediaMarkdown";
import type { QueuedMediaAttachment } from "@/features/messages/lib/backgroundMediaUploadStore";
import type {
  DraftMentionRef,
  UseDraftsResult,
} from "@/features/messages/lib/useDrafts";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { MENTION_REFERENCE_TAG } from "@/shared/lib/resolveMentionNames";

export { MENTION_REFERENCE_TAG };

export type PendingNonMemberMentionSend = {
  capturedChannelId: string | null;
  capturedThreadContext: {
    parentEventId: string | null;
    threadHeadId: string | null;
  } | null;
  trimmed: string;
  mentionPubkeys: string[];
  nonMemberPubkeys: string[];
  outgoingTags?: string[][];
  preparedManagedAgents?: ManagedAgent[];
  readyAgentPubkeys?: string[];
  savedContent: string;
  savedImeta: ImetaMedia[];
  queuedAttachments: QueuedMediaAttachment[];
  savedSpoileredAttachmentUrls: Set<string>;
  sentDraftKey: string | null | undefined;
  recoveryDraftKey: string | null | undefined;
  savedMentionRefs: DraftMentionRef[];
  audienceGeneration: number;
  audienceRevision: number | null;
  explicitAgentPubkeys: string[];
};

export type SendMessageWithMentionFlowInput = {
  capturedChannelId: string | null;
  capturedThreadContext?: PendingNonMemberMentionSend["capturedThreadContext"];
  pendingImeta: ImetaMedia[];
  queuedAttachments?: QueuedMediaAttachment[];
  linkPreviewTags?: string[][];
  sentDraftKey: string | null | undefined;
  recoveryDraftKey: string | null | undefined;
  spoileredAttachmentUrls?: ReadonlySet<string>;
  trimmed: string;
  audienceGeneration?: number;
  audienceRevision?: number | null;
};

export function mergeOutgoingTagsWithReferenceMentions(
  outgoingTags: string[][] | undefined,
  pubkeys: Iterable<string>,
) {
  const normalizedPubkeys = uniqueNormalizedPubkeys(pubkeys);
  if (normalizedPubkeys.length === 0) {
    return outgoingTags;
  }

  return [
    ...(outgoingTags ?? []),
    ...normalizedPubkeys.map((pubkey) => [MENTION_REFERENCE_TAG, pubkey]),
  ];
}

/**
 * `threadRoot` is the root event id of the thread this send replies in, and
 * `null` at channel root. It reaches the Task so the relay can scope its
 * task-created notice into that thread; without it every notice landed at
 * channel root, where it read as the work having been started somewhere the
 * owner was not looking.
 */
export async function attachOutgoingWorkContext(
  channelId: string,
  content: string,
  agentPubkeys: readonly string[],
  mediaTags: string[][] | undefined,
  outgoingTags?: string[][],
  threadRoot?: string | null,
) {
  return await attachWorkContext({
    channelId,
    content,
    agentPubkeys,
    outgoingTags: mergeOutgoingTags(mediaTags, outgoingTags ?? []) ?? [],
    threadRoot: threadRoot ?? null,
  });
}

/**
 * The thread a send belongs to, as the Task should name it.
 *
 * A reply deep in a thread names the thread's head, not its immediate parent,
 * because the relay's row marker is `["e", root, "", "root"]`. When only a
 * parent is known it is the head: a first reply's parent is the thread root.
 */
export function threadRootForWorkContext(
  threadContext: {
    parentEventId: string | null;
    threadHeadId: string | null;
  } | null,
): string | null {
  return threadContext?.threadHeadId ?? threadContext?.parentEventId ?? null;
}

export function buildTypedMentionRouting({
  content,
  pendingImeta,
  spoileredAttachmentUrls,
  mentionPubkeys,
  createdPersonaAgentPubkeys,
  customEmoji,
  linkPreviewTags,
  routeTypedMentionReferences,
}: {
  content: string;
  pendingImeta: ImetaMedia[];
  spoileredAttachmentUrls: ReadonlySet<string>;
  mentionPubkeys: string[];
  createdPersonaAgentPubkeys: string[];
  customEmoji: CustomEmoji[];
  linkPreviewTags: string[][];
  routeTypedMentionReferences: (
    content: string,
    actorPubkeys: readonly string[],
  ) => { actorPubkeys: string[]; referenceTags: string[][] };
}) {
  const { content: routedContent } = buildOutgoingMessage(
    content,
    pendingImeta,
    spoileredAttachmentUrls,
  );
  const routed = routeTypedMentionReferences(
    routedContent,
    uniqueNormalizedPubkeys([...mentionPubkeys, ...createdPersonaAgentPubkeys]),
  );
  const ordinaryOutgoingTags = [
    ...buildCustomEmojiTags(routedContent, customEmoji),
    ...linkPreviewTags,
  ];
  return {
    ...routed,
    outgoingTags:
      ordinaryOutgoingTags.length > 0 || routed.referenceTags.length > 0
        ? [...ordinaryOutgoingTags, ...routed.referenceTags]
        : undefined,
  };
}

export function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * finishSend attaches work context (a Task charge on the relay) before
 * sending. That attach step can fail for reasons the user needs to read and
 * act on ("this community has no coordination team...", "the message has
 * not been sent."), so a caught failure here always surfaces the underlying
 * message, not just a silent draft restore.
 *
 * Takes `restoreComposerAfterFailure` as a parameter rather than closing
 * over it, so the handler can live here with the rest of this hook's
 * extracted logic instead of inline in the hook body.
 *
 * An error the caller has already put in front of the user (see
 * `markSendFailureReported`) restores the composer without a toast, so the
 * same sentence is not reported twice.
 */
export function createFinishSendFailureHandler(
  restoreComposerAfterFailure: () => void,
) {
  return (error: unknown) => {
    restoreComposerAfterFailure();
    if (wasSendFailureReported(error)) return;
    toast.error(getErrorMessage(error, "The message could not be sent."));
  };
}

/**
 * Marker for a send failure the `onSend` caller has already shown the user on
 * its own error surface.
 *
 * The new-message screen renders a failed first DM as an inline banner and
 * rethrows, so once completeSend started reporting send() rejections the same
 * sentence appeared twice, and the smoke spec's strict locator resolved to
 * two elements. A symbol on the rejected error carries "this one is already
 * reported" from the caller to the handler without threading a prop through
 * MessageComposer for a case only that one screen has.
 */
const SEND_FAILURE_REPORTED = Symbol.for("buzz.sendFailureReported");

/** Tag `error` as already reported, and return it so callers can `throw` it. */
export function markSendFailureReported<T>(error: T): T {
  if (error !== null && typeof error === "object") {
    Object.defineProperty(error, SEND_FAILURE_REPORTED, {
      configurable: true,
      value: true,
    });
  }
  return error;
}

export function wasSendFailureReported(error: unknown) {
  return (
    error !== null &&
    typeof error === "object" &&
    SEND_FAILURE_REPORTED in error
  );
}

/**
 * Run `finishSend`, reporting anything it rejects with instead of swallowing
 * it.
 *
 * Both of completeSend's outer catch sites used to restore the draft and say
 * nothing, on the premise that a failure reaching them had already been
 * toasted by the attach step. The premise is false: attach catches its own
 * failure and `return`s, so the only errors that ever arrive here are
 * `send()`'s. Every one of them was invisible. A message rejected by the
 * native send command (for example a tag the event builder refuses) came back
 * as a restored draft and nothing else, and the owner had no way to tell a
 * failed send from one that had not been attempted.
 *
 * A caller that shows its own inline error for a failed send (the new-message
 * screen does) marks the error it rethrows, so each failure is reported
 * exactly once: inline there, as a toast everywhere else.
 */
export async function runReportingFinishSendFailures(
  finishSend: () => Promise<void>,
  handleFinishSendFailure: (error: unknown) => void,
): Promise<void> {
  try {
    await finishSend();
  } catch (error) {
    handleFinishSendFailure(error);
  }
}

/**
 * Re-persist a draft that a completeSend attempt bailed out of (channel
 * changed mid-flight, upload canceled, work-context attach failed) so it is
 * not lost. Skips the write if whatever is currently stored under
 * `recoveryDraftKey` no longer matches what completeSend captured at the
 * start of the attempt, so this never clobbers a newer edit made in the
 * meantime.
 */
export function persistCanceledDraftIfUnchanged(
  draft: PendingNonMemberMentionSend,
  drafts: Pick<UseDraftsResult, "loadDraft" | "persistDraft">,
) {
  if (!draft.recoveryDraftKey) return;
  const existing = drafts.loadDraft(draft.recoveryDraftKey);
  if (
    existing &&
    (existing.content !== draft.savedContent ||
      existing.channelId !==
        (draft.capturedChannelId ?? draft.recoveryDraftKey) ||
      JSON.stringify(existing.pendingImeta) !==
        JSON.stringify(draft.savedImeta) ||
      JSON.stringify(existing.spoileredAttachmentUrls) !==
        JSON.stringify([...draft.savedSpoileredAttachmentUrls]))
  ) {
    return;
  }
  drafts.persistDraft(
    draft.recoveryDraftKey,
    draft.savedContent,
    draft.capturedChannelId ?? draft.recoveryDraftKey,
    draft.savedImeta,
    [...draft.savedSpoileredAttachmentUrls],
    draft.savedMentionRefs,
  );
}

export function uniqueNormalizedPubkeys(pubkeys: Iterable<string>) {
  return [...new Set([...pubkeys].map(normalizePubkey))].filter(Boolean);
}

export function isManagedAgentRunning(agent: ManagedAgent) {
  return agent.status === "running" || agent.status === "deployed";
}

export function isProviderBackedAgent(agent: ManagedAgent) {
  return agent.backend.type === "provider";
}
