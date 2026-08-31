import type { ThreadPing } from "./threadPings";
import type { SendChannelMessageResult } from "@/shared/api/types";

export type DelegateAnswerToLeadDependencies = {
  sendChannelMessage: (input: {
    channelId: string;
    content: string;
    parentEventId: string;
    mentionPubkeys: string[];
  }) => Promise<SendChannelMessageResult>;
};

/**
 * The plain-text body a delegation reply posts. This is NOT a relay-enforced
 * grant (see docs/nips/NIP-IQ.md's kind 30189 delegation grant for that) --
 * an ordinary message stating what the owner decided, exactly like any other
 * reply a person reading the thread later would read.
 */
export function buildDelegateAnswerContent(leadLabel: string): string {
  return `${leadLabel}, the owner has delegated this decision to you. You have full authority to decide.`;
}

/**
 * Hands a ping off to the asker's lead (spec item 4): a plain reply in the
 * ping's own thread, p-tagging the lead, stating the owner delegated the
 * decision. No new event kind, no protocol-enforced authority -- callers
 * dismiss the ping separately once this lands (see `dismissThreadPing`).
 */
export async function delegateAnswerToLead(
  ping: Pick<ThreadPing, "id" | "channelId">,
  lead: { pubkey: string; label: string },
  dependencies: DelegateAnswerToLeadDependencies,
): Promise<void> {
  await dependencies.sendChannelMessage({
    channelId: ping.channelId,
    content: buildDelegateAnswerContent(lead.label),
    parentEventId: ping.id,
    mentionPubkeys: [lead.pubkey],
  });
}
