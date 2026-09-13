import * as React from "react";

import type { useMentions } from "@/features/messages/lib/useMentions";

/**
 * Colony-only: the reply model derives its recipient set from the composer's
 * link-preview content string. Upstream dropped that state when the composer
 * moved to the managed link-preview hook, so it lives here — also keeping
 * `MessageComposer.tsx` under the desktop file-size ratchet.
 */
export function useComposerReplyRecipients(
  mentions: ReturnType<typeof useMentions>,
  channelType: string | null,
): {
  recipientPubkeys: string[];
  trackPreviewContent: (content: string) => void;
} {
  const [previewContent, setPreviewContent] = React.useState("");
  const recipientPubkeys = [
    ...mentions.extractMentionPubkeys(previewContent),
    ...(channelType === "dm" ? mentions.memberPubkeys : []),
  ];
  return { recipientPubkeys, trackPreviewContent: setPreviewContent };
}
