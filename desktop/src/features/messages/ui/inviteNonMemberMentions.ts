import type { ManagedAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { MENTION_REFERENCE_TAG } from "@/shared/lib/resolveMentionNames";
import type { PendingNonMemberMentionSend } from "./useMentionSendFlow.helpers";

type AddMembersInput = {
  channelId?: string;
  pubkeys: string[];
  role: "member" | "bot";
};

type AddMembersResult = {
  errors: readonly { error: string }[];
};

export type InviteNonMemberMentionsInput = {
  pending: PendingNonMemberMentionSend;
  getManagedAgentsByPubkey: () => Promise<Map<string, ManagedAgent>>;
  isAgentPubkey: (pubkey: string) => boolean;
  addMembers: (input: AddMembersInput) => Promise<AddMembersResult>;
  completeSend: (
    pending: PendingNonMemberMentionSend,
    mentionPubkeys: string[],
    outgoingTags: string[][],
  ) => Promise<void>;
};

function uniqueNormalizedPubkeys(pubkeys: readonly string[]): string[] {
  return [...new Set(pubkeys.map((pubkey) => normalizePubkey(pubkey)))];
}

/**
 * Invite the pending non-member mentions, then continue the original send.
 * Keeping this async work outside the composer hook makes the retry boundary
 * explicit: a failed invitation returns its message and never starts send.
 */
export async function inviteNonMemberMentions({
  pending,
  getManagedAgentsByPubkey,
  isAgentPubkey,
  addMembers,
  completeSend,
}: InviteNonMemberMentionsInput): Promise<string | null> {
  const invitedPubkeys = new Set(
    pending.nonMemberPubkeys.map((pubkey) => normalizePubkey(pubkey)),
  );
  const mentionPubkeys = uniqueNormalizedPubkeys([
    ...pending.mentionPubkeys,
    ...pending.nonMemberPubkeys,
  ]);
  const outgoingTags = (pending.outgoingTags ?? []).filter(
    (tag) =>
      tag[0] !== MENTION_REFERENCE_TAG ||
      !invitedPubkeys.has(normalizePubkey(tag[1] ?? "")),
  );

  try {
    const managedAgentsByPubkey = await getManagedAgentsByPubkey();
    const peoplePubkeys: string[] = [];
    const relayAgentPubkeys: string[] = [];
    for (const pubkey of uniqueNormalizedPubkeys(pending.nonMemberPubkeys)) {
      if (managedAgentsByPubkey.has(pubkey)) continue;
      if (isAgentPubkey(pubkey)) relayAgentPubkeys.push(pubkey);
      else peoplePubkeys.push(pubkey);
    }

    const errors: string[] = [];
    if (peoplePubkeys.length > 0) {
      const result = await addMembers({
        channelId: pending.capturedChannelId ?? undefined,
        pubkeys: peoplePubkeys,
        role: "member",
      });
      errors.push(...result.errors.map((error) => error.error));
    }
    if (relayAgentPubkeys.length > 0) {
      const result = await addMembers({
        channelId: pending.capturedChannelId ?? undefined,
        pubkeys: relayAgentPubkeys,
        role: "bot",
      });
      errors.push(...result.errors.map((error) => error.error));
    }
    if (errors.length > 0) return errors.join("; ");

    await completeSend(
      { ...pending, mentionPubkeys, outgoingTags },
      mentionPubkeys,
      outgoingTags,
    );
    return null;
  } catch (error) {
    return error instanceof Error && error.message.trim().length > 0
      ? error.message
      : "Could not invite members.";
  }
}
