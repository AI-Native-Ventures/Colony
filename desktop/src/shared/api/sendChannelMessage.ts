/**
 * Sending a stream, forum or DM message through the native command.
 *
 * Split out of `tauri.ts` because that file sits on the desktop file-size
 * ratchet, and because this call has its own contract worth reading in one
 * place: two separately validated tag channels that must not be confused.
 */
import { invokeTauri } from "@/shared/api/tauri";
import type { RawSendChannelMessageResult } from "@/shared/api/tauriMessageTypes";
import type { SendChannelMessageResult } from "@/shared/api/types";

/**
 * Everything a stream message can carry beyond its channel and body.
 *
 * Named rather than positional on purpose. This was eleven positional
 * parameters, and on 2026-08-27 onboarding's `["client", marker]` idempotency
 * marker was passed at the slot that happened to be `referenceTags` — the
 * Blocks-only channel — so first-run completion failed with "invalid Block
 * reference tag" for every new user. At the call site the argument looked
 * right; only the command's own validator could tell it apart. The two tag
 * channels are now impossible to confuse by position:
 *
 * - `blockReferenceTags` — Block coordinates, manifests and data refs. Strictly
 *   validated in `desktop/src-tauri/src/events/reference_tags.rs`.
 * - `clientTags` — `["client", …]` markers, for idempotency and provenance.
 *   Validated in `append_client_tags`; cannot forge channel or thread metadata.
 */
export type SendChannelMessageInput = {
  channelId: string;
  content: string;
  parentEventId?: string | null;
  mediaTags?: string[][];
  mentionPubkeys?: string[];
  kind?: number;
  emojiTags?: string[][];
  mentionTags?: string[][];
  /** Block reference tags only. A `client` marker here is rejected. */
  blockReferenceTags?: string[][];
  /** `["client", marker]` tags, for idempotency markers. */
  clientTags?: string[][];
  linkPreviewTags?: string[][];
  sentFromThreadTag?: string[];
};

export async function sendChannelMessage({
  channelId,
  content,
  parentEventId,
  mediaTags,
  mentionPubkeys,
  kind,
  emojiTags,
  mentionTags,
  blockReferenceTags,
  clientTags,
  linkPreviewTags,
  sentFromThreadTag,
}: SendChannelMessageInput): Promise<SendChannelMessageResult> {
  const response = await invokeTauri<RawSendChannelMessageResult>(
    "send_channel_message",
    {
      channelId,
      content,
      parentEventId,
      mediaTags: mediaTags ?? null,
      emojiTags: emojiTags ?? null,
      mentionTags: mentionTags ?? null,
      blockReferenceTags: blockReferenceTags ?? null,
      clientTags: clientTags ?? null,
      linkPreviewTags,
      sentFromThreadTag: sentFromThreadTag ?? null,
      mentionPubkeys: mentionPubkeys ?? null,
      kind: kind ?? null,
    },
  );
  return {
    eventId: response.event_id,
    parentEventId: response.parent_event_id,
    rootEventId: response.root_event_id,
    depth: response.depth,
    createdAt: response.created_at,
  };
}
