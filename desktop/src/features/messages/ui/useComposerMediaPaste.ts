import * as React from "react";

import type { Editor } from "@tiptap/react";
import type { MediaUploadController } from "@/features/messages/lib/useMediaUpload";
import type { BindPastedMentionIdentities } from "@/features/messages/lib/mentionPasteBinding";
import {
  handleAgentSnapshotPaste,
  parseSnapshotClipboardHtml,
} from "@/features/messages/lib/agentSnapshotClipboard";
import { getBuzzCodeBlockClipboardText } from "@/shared/lib/codeBlockClipboard";
import { handleMentionClipboardPaste } from "@/features/messages/lib/mentionClipboardPaste";

/**
 * Media paste and the ⌘K link shortcut, installed on Tiptap's `editorProps`.
 *
 * Split out of `MessageComposer` for the desktop size ratchet. Colony keeps its
 * own paste handler rather than upstream's `useComposerPasteHandler` (that hook
 * is #6714's), so #7228's identity binding is wired here: the chips a paste
 * carried are verified against trusted state and re-bound to their pubkeys,
 * which is what makes a pasted mention send as a mention.
 */
export function useComposerMediaPaste({
  acceptsAttachmentRef,
  bindPastedMentionIdentities,
  editor,
  media,
  scrollComposerToBottom,
}: {
  /** False while a voice note is recording or queued: the composer holds one
   *  attachment at a time, so a pasted file or snapshot is refused rather than
   *  silently replacing the recording (#6978). */
  acceptsAttachmentRef: React.RefObject<boolean>;
  bindPastedMentionIdentities: BindPastedMentionIdentities;
  editor: Editor | null;
  media: Pick<MediaUploadController, "setPendingImeta" | "uploadFile">;
  scrollComposerToBottom: () => void;
}) {
  const bindPastedMentionIdentitiesRef = React.useRef(
    bindPastedMentionIdentities,
  );
  bindPastedMentionIdentitiesRef.current = bindPastedMentionIdentities;
  const uploadFileRef = React.useRef(media.uploadFile);
  uploadFileRef.current = media.uploadFile;
  React.useEffect(() => {
    if (!editor) return;
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        handlePaste: (_view, event) => {
          // --- File paste ---
          // Any actual file (image, video, document, …) pastes as an
          // attachment. String/text items have kind "string", so plain-text
          // and code-block paste fall through to the handlers below.
          const items = Array.from(event.clipboardData?.items ?? []);
          const mediaItem = items.find((item) => item.kind === "file");
          if (mediaItem) {
            if (!acceptsAttachmentRef.current) return true;
            const file = mediaItem.getAsFile();
            if (file) {
              void uploadFileRef.current(file);
            }
            return true;
          }
          // --- Buzz code-block paste ---
          // The code block copy button writes a small Buzz marker alongside
          // plain text. Use it to paste back as a literal code block so Markdown
          // parsing cannot reshape indentation, fence markers, or headings.
          const codeBlockText = getBuzzCodeBlockClipboardText(
            event.clipboardData,
          );
          if (codeBlockText !== null) {
            event.preventDefault();
            editor
              ?.chain()
              .focus()
              .insertContent([
                {
                  type: "codeBlock",
                  content:
                    codeBlockText.length > 0
                      ? [{ type: "text", text: codeBlockText }]
                      : [],
                },
                { type: "paragraph" },
              ])
              .run();
            scrollComposerToBottom();
            return true;
          }
          // Restore Buzz snapshots before normal styled-HTML normalization,
          // and refuse them while a voice note owns the attachment slot.
          if (
            !acceptsAttachmentRef.current &&
            parseSnapshotClipboardHtml(
              event.clipboardData?.getData("text/html") ?? "",
            )
          ) {
            event.preventDefault();
            return true;
          }
          if (handleAgentSnapshotPaste(event, media.setPendingImeta))
            return true;
          // Strip mention/channel wrappers that Tiptap would misread as bold.
          // Colony keeps its own paste handler rather than upstream's
          // `useComposerPasteHandler` (that hook is #6714's), so #7228's
          // identity binding is wired here: the chips the paste carried are
          // verified against trusted state and re-bound to their pubkeys,
          // which is what makes a pasted mention send as a mention.
          if (event.clipboardData) {
            const bound = handleMentionClipboardPaste({
              bindMentionIdentities: bindPastedMentionIdentitiesRef.current,
              clipboardData: event.clipboardData,
              preventDefault: () => event.preventDefault(),
              view: _view,
            });
            if (bound) return true;
          }
          const plainText = event.clipboardData?.getData("text/plain") ?? "";
          if (plainText.includes("\n")) {
            scrollComposerToBottom();
          }
          return false;
        },
      },
    });
  }, [media.setPendingImeta, editor, scrollComposerToBottom]);
}
