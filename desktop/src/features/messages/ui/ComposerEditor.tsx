import type * as React from "react";
import { EditorContent, type Editor } from "@tiptap/react";
import { cn } from "@/shared/lib/cn";
import type { ComposerDictationControl } from "../lib/useComposerDictation";
import { ComposerDictation } from "./ComposerDictation";

/** Keep the editor mounted so dictation preserves its document and selection. */
export function ComposerEditor({
  editor,
  dictation,
  scrollRef,
  onKeyDown,
}: {
  editor: Editor | null;
  dictation: ComposerDictationControl;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
}) {
  return (
    <>
      <ComposerDictation control={dictation} />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keydown bridges Tiptap to autocomplete and submit */}
      <div
        className={cn(
          "rich-text-composer relative max-h-32 overflow-y-auto",
          dictation.active && "hidden",
        )}
        data-testid="message-input-scroll"
        ref={scrollRef}
        onKeyDown={onKeyDown}
      >
        <EditorContent editor={editor} />
      </div>
    </>
  );
}
