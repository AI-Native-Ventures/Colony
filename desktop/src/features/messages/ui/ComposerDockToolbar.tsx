import type { ComponentProps } from "react";

import { DictationButton } from "./ComposerDictation";
import type { ComposerDictationControl } from "../lib/useComposerDictation";
import { MessageComposerToolbar } from "@/features/messages/ui/MessageComposerToolbar";

type ComposerDockToolbarProps = ComponentProps<
  typeof MessageComposerToolbar
> & {
  layoutMode: "dock" | "standalone";
  dictation?: ComposerDictationControl;
};

/**
 * Keeps the composer dock's total height stable by trading a quiet-state spacer
 * for the equal-height activity rail outside the composer.
 */
export function ComposerDockToolbar({
  layoutMode,
  dictation,
  ...toolbarProps
}: ComposerDockToolbarProps) {
  return (
    <>
      {layoutMode === "dock" ? (
        <div
          aria-hidden="true"
          className="composer-dock-quiet-spacer shrink-0"
        />
      ) : null}
      <MessageComposerToolbar
        {...toolbarProps}
        composerDisabled={
          toolbarProps.composerDisabled || (dictation?.active ?? false)
        }
        formattingDisabled={
          toolbarProps.formattingDisabled || (dictation?.active ?? false)
        }
        sendDisabled={toolbarProps.sendDisabled || (dictation?.active ?? false)}
        dictationAction={
          dictation && (
            <DictationButton
              control={dictation}
              disabled={toolbarProps.composerDisabled || toolbarProps.isSending}
            />
          )
        }
      />
    </>
  );
}
