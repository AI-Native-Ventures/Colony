import type { AudioAttachmentImetaEntry } from "@/features/messages/lib/audioAttachment";
import { isVoiceNoteAttachment } from "@/features/messages/lib/audioAttachment";
import { renderAudioMessageAttachment } from "@/features/messages/ui/AudioMessageAttachment";

import { isRelayDownloadable } from "./mediaEntry";

/**
 * A voice note's rendered attachment surface, or `null` for anything else.
 *
 * Audio splits by kind, not by which path the link took: a voice-note
 * descriptor gets upstream's attachment surface (waveform, load and playback
 * retry, resume-after-load, one player at a time), and every other audio link
 * keeps Colony's `MarkdownAudioPlayer`. Both the `a` and the `img` renderer in
 * markdown.tsx ask this, so the split is decided in one place.
 *
 * `block` wraps the result in the media-paragraph span the `img` path needs,
 * so both call sites stay one expression.
 *
 * Split out of markdown.tsx for the desktop size ratchet, the same way
 * MarkdownMentionChip was; the behaviour is unchanged.
 */
export function renderVoiceNoteAttachment({
  block = false,
  entry,
  label,
  relayOrigin,
  url,
}: {
  block?: boolean;
  entry: AudioAttachmentImetaEntry | undefined;
  label: string;
  relayOrigin: string | null | undefined;
  url: string | undefined;
}) {
  if (!isVoiceNoteAttachment(entry)) return null;
  const attachment = renderAudioMessageAttachment(
    entry,
    url,
    label,
    url && isRelayDownloadable(url, relayOrigin ?? undefined) ? url : undefined,
  );
  if (!attachment || !block) return attachment;
  return (
    <span data-block-media="" className="block w-full">
      {attachment}
    </span>
  );
}
