import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";
import { interReady } from "./fonts";

/**
 * Holds the frame until Inter has loaded, so no frame paints a fallback font.
 * Returns true once it has, and the re-render it causes lets anything that
 * measures text measure it in Inter.
 */
export function useFontsReady(): boolean {
  const [handle] = useState(() => delayRender("Loading Inter"));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    interReady
      .then(() => setReady(true))
      .catch((err: unknown) => cancelRender(err));
  }, []);
  useEffect(() => {
    if (ready) continueRender(handle);
  }, [ready, handle]);
  return ready;
}
