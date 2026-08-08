import {
  isFullscreen as isNativeFullscreen,
  onWindowResized,
} from "@/shared/api/nativeBridge";
import * as React from "react";

/**
 * Returns whether the current Tauri window is in fullscreen mode.
 *
 * Initial value resolves from `isFullscreen()`; subsequent updates come from
 * `onResized` (macOS native fullscreen, Windows F11, and Linux fullscreen all
 * fire a resize on transition). Each consumer owns one listener cleaned up on
 * unmount.
 */
export function useIsFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = React.useState(false);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void isNativeFullscreen().then((value) => {
      if (!cancelled) {
        setIsFullscreen(value);
      }
    });

    void onWindowResized(() => {
      void isNativeFullscreen().then((value) => {
        if (!cancelled) {
          setIsFullscreen(value);
        }
      });
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return isFullscreen;
}
