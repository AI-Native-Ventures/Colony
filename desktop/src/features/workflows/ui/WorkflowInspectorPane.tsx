import { AnimatePresence, motion, useIsPresent } from "motion/react";
import type * as React from "react";

const inspectorContentVariants = {
  enter: (direction: number) => ({
    opacity: 0,
    y: direction < 0 ? 12 : -12,
  }),
  center: { opacity: 1, y: 0 },
  // The exit resolves in the same frame on purpose. `AnimatePresence` runs in
  // `mode="wait"`, so anything spent here is time the pane the user just left
  // stays mounted while the pane they asked for has not rendered yet. See
  // InspectorPaneBody for what that window costs.
  exit: (direction: number) => ({
    opacity: 0,
    transition: { duration: 0 },
    y: direction < 0 ? -12 : 12,
  }),
};

/**
 * Holds the inspector body of a pane that is animating out.
 *
 * Both panes carry fields with the same visible label ("Message text" is a
 * trigger filter and a send_message field), so while an outgoing pane is still
 * mounted the only match for that label is a field belonging to a pane the user
 * has already left: a keystroke, or an automated fill, lands in the trigger
 * filter instead of the step it was aimed at. `inert` is not enough on its own,
 * since it stops the keystroke from landing but the field still answers a label
 * lookup, so the input goes nowhere instead of going astray. The fields are
 * dropped outright once the pane starts leaving, which together with the
 * zero-length exit above means a pane is either the current one or gone.
 */
function InspectorPaneBody({ children }: { children: React.ReactNode }) {
  const isPresent = useIsPresent();
  return (
    <div
      aria-hidden={isPresent ? undefined : "true"}
      className="h-full min-h-0"
      inert={!isPresent}
    >
      {isPresent ? children : null}
    </div>
  );
}

/**
 * Animates the workflow editor inspector between the trigger pane and a step
 * pane. `paneKey` identifies the pane the children belong to; changing it swaps
 * the body.
 */
export function WorkflowInspectorPane({
  children,
  direction,
  paneKey,
  reduceMotion,
}: {
  children: React.ReactNode;
  direction: 1 | -1;
  paneKey: string;
  reduceMotion: boolean | null;
}) {
  return (
    <AnimatePresence custom={direction} initial={false} mode="wait">
      <motion.div
        animate="center"
        className="h-full min-h-0"
        custom={direction}
        exit="exit"
        initial="enter"
        key={paneKey}
        transition={
          reduceMotion ? { duration: 0 } : { duration: 0.15, ease: "easeOut" }
        }
        variants={inspectorContentVariants}
      >
        <InspectorPaneBody>{children}</InspectorPaneBody>
      </motion.div>
    </AnimatePresence>
  );
}
