import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";
import { fontsReady } from "./fonts";

/**
 * Holds the frame until every face has loaded, so no frame paints a fallback
 * font. Returns true once they have, and the re-render it causes lets anything
 * that measures text measure it in Inter.
 */
export function useFontsReady(): boolean {
  const [handle] = useState(() => delayRender("Loading fonts"));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    fontsReady
      .then(() => setReady(true))
      .catch((err: unknown) => cancelRender(err));
  }, []);
  useEffect(() => {
    if (ready) continueRender(handle);
  }, [ready, handle]);
  return ready;
}
