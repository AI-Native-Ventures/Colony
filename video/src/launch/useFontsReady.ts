import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";
import { interReady } from "./fonts";

/** Holds the frame until Inter has loaded, so no frame paints a fallback font. */
export function useFontsReady(): void {
  const [handle] = useState(() => delayRender("Loading Inter"));
  useEffect(() => {
    interReady
      .then(() => continueRender(handle))
      .catch((err: unknown) => cancelRender(err));
  }, [handle]);
}
