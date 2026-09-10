import * as React from "react";
import { scheduleSettleGatedAutoSubmit } from "./messageComposerAutoSubmit";

/** Consume a confirmed draft trigger once, after its link snapshots settle. */
export function useComposerAutoSubmit(
  trigger: string | null,
  draftKey: string | null | undefined,
  onComplete: (() => void) | undefined,
  pending: React.RefObject<boolean>,
  submit: React.RefObject<() => void>,
) {
  const completeRef = React.useRef(onComplete);
  completeRef.current = onComplete;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route trigger is mount-only; refs keep callbacks current.
  React.useEffect(() => {
    if (trigger === null || trigger !== draftKey) return;
    completeRef.current?.();
    return scheduleSettleGatedAutoSubmit({
      isPending: () => pending.current,
      submit: () => submit.current(),
    });
  }, []);
}
