import type { ManagedAgent } from "@/shared/api/types";
import type { CustomEmoji } from "@/shared/lib/remarkCustomEmoji";
import { buildCustomEmojiTags } from "@/shared/lib/customEmojiTags";
import { buildOutgoingMessage } from "@/features/messages/lib/imetaMediaMarkdown";
import { attachWorkContext } from "@/features/company/attachWorkContext";
import { mergeOutgoingTags } from "@/features/messages/lib/imetaMediaMarkdown";
import type { ImetaMedia } from "@/features/messages/lib/imetaMediaMarkdown";
import type { QueuedMediaAttachment } from "@/features/messages/lib/backgroundMediaUploadStore";
import type { DraftMentionRef } from "@/features/messages/lib/useDrafts";
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

export async function attachOutgoingWorkContext(
  channelId: string,
  content: string,
  agentPubkeys: readonly string[],
  mediaTags: string[][] | undefined,
  outgoingTags?: string[][],
) {
  return await attachWorkContext({
    channelId,
    content,
    agentPubkeys,
    outgoingTags: mergeOutgoingTags(mediaTags, outgoingTags ?? []) ?? [],
  });
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

export function uniqueNormalizedPubkeys(pubkeys: Iterable<string>) {
  return [...new Set([...pubkeys].map(normalizePubkey))].filter(Boolean);
}

export function isManagedAgentRunning(agent: ManagedAgent) {
  return agent.status === "running" || agent.status === "deployed";
}

export function isProviderBackedAgent(agent: ManagedAgent) {
  return agent.backend.type === "provider";
}
