import type { Editor } from "@tiptap/react";

import { CUSTOM_EMOJI_NODE_NAME } from "@/features/messages/lib/customEmojiNode";
import type { CustomEmoji } from "@/shared/lib/remarkCustomEmoji";

/**
 * Insert an emoji at the cursor: a `:shortcode:` for a known custom emoji
 * becomes a selectable atom node (same as the input rule and autocomplete), so
 * it can be selected, copied and deleted as one unit; anything else, including
 * native unicode, inserts as plain content.
 *
 * Split out of `MessageComposer` for the desktop file-size ratchet.
 */
export function insertComposerEmoji(
  emoji: string,
  deps: {
    customEmoji: CustomEmoji[];
    editor: Editor | null;
  },
): void {
  const { customEmoji, editor } = deps;
  if (!editor) return;
  // A `:shortcode:` for a known custom emoji becomes a selectable atom
  // node (same as the input rule / autocomplete), so it can be selected,
  // copied, and deleted as one unit. Everything else (native unicode)
  // inserts as plain content.
  const match = /^:([^:\s]+):$/.exec(emoji);
  const shortcode = match?.[1]?.toLowerCase();
  const known =
    shortcode &&
    customEmoji.some((e) => e.shortcode.toLowerCase() === shortcode);
  if (known && shortcode) {
    editor
      .chain()
      .focus()
      .insertContent({
        type: CUSTOM_EMOJI_NODE_NAME,
        attrs: {
          shortcode,
          src:
            customEmoji.find((e) => e.shortcode.toLowerCase() === shortcode)
              ?.url ?? "",
        },
      })
      .insertContent(" ")
      .run();
  } else {
    editor.chain().focus().insertContent(emoji).run();
  }
}
