import * as React from "react";
import { closeWindow, isTauri } from "@/shared/api/nativeBridge";
import { isMacPlatform } from "@/shared/lib/platform";

type CloseWindowChord = Pick<
  KeyboardEvent,
  | "altKey"
  | "code"
  | "ctrlKey"
  | "defaultPrevented"
  | "isComposing"
  | "metaKey"
  | "repeat"
  | "shiftKey"
>;

export function isCloseWindowShortcut(
  event: CloseWindowChord,
  isMac: boolean,
): boolean {
  return (
    isMac &&
    event.code === "KeyW" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.defaultPrevented &&
    !event.isComposing &&
    !event.repeat
  );
}

/**
 * Restores the standard macOS Cmd+W behavior without reclaiming the native
 * menu accelerator. Buzz Term handles the chord first in capture phase while
 * it owns input; otherwise this bubble-phase listener closes the current
 * window. The main window's Rust close handler turns that into hide-to-tray.
 *
 * Electron is deliberately left out: it ships the default macOS menu, whose
 * Close Window role already claims Cmd+W, and its window close handler quits
 * Colony outright (no tray to hide to), so routing the chord through the
 * renderer would either double-fire the accelerator or need a hide path the
 * Electron shell does not have.
 */
export function useCloseWindowShortcut() {
  React.useEffect(() => {
    if (!isTauri()) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (!isCloseWindowShortcut(event, isMacPlatform())) return;
      event.preventDefault();
      void closeWindow();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
