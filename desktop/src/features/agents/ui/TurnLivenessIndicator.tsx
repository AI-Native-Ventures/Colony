import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/shared/lib/cn";
import { useNow } from "@/shared/lib/useNow";
import { FuzzyMark } from "@/shared/ui/colony-logo/FuzzyMark";
import { useAgentLiveness } from "@/features/agents/useAgentLiveness";
import type { AgentLivenessState } from "@/features/agents/agentLivenessState";
import { formatDurationMs } from "./agentSessionUtils";
import { useTranscriptAnimationEnabled } from "./transcriptAnimationPreference";

const MARKS = ["first", "second", "third"] as const;
const STAGGER_SECONDS = 0.25;
const CYCLE_SECONDS = 1.8;
/** Minute-granular copy, so a slow tick. Mounted only while a turn is live. */
const NOTE_TICK_MS = 30_000;

export function TurnLivenessIndicator({
  agentPubkey,
  channelId = null,
  className,
  fuzz = false,
}: {
  /** When given, the indicator can say what the silence means. */
  agentPubkey?: string | null;
  channelId?: string | null;
  className?: string;
  /** Defaults to false — the indicator stays mounted for whole turns. */
  fuzz?: boolean;
}) {
  const animationsEnabled = useTranscriptAnimationEnabled();
  const shouldReduceMotion = useReducedMotion();
  const showStaggeredRow = animationsEnabled && !shouldReduceMotion;

  return (
    <div
      aria-label="Agent turn in progress"
      className={cn("flex flex-col gap-1", className)}
      data-testid="turn-liveness-indicator"
      role="status"
    >
      {showStaggeredRow ? (
        <div className="flex items-center gap-1.5 opacity-25">
          {MARKS.map((mark, index) => (
            <motion.div
              animate={{
                opacity: [0, 1, 1, 0],
                y: [4, 0, -1, -4],
              }}
              key={mark}
              transition={{
                delay: index * STAGGER_SECONDS,
                duration: CYCLE_SECONDS,
                ease: "easeInOut",
                repeat: Number.POSITIVE_INFINITY,
                times: [0, 0.3, 0.7, 1],
              }}
            >
              <FuzzyMark
                ariaLabel=""
                className="w-5! text-foreground"
                fuzz={fuzz}
                pulse={false}
              />
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="opacity-25">
          <FuzzyMark
            ariaLabel="Agent turn in progress"
            className="w-5! text-foreground"
            fuzz={fuzz}
            loop
            loopRestSeconds={2}
          />
        </div>
      )}
      {agentPubkey ? (
        <QuietTurnNote agentPubkey={agentPubkey} channelId={channelId} />
      ) : null}
    </div>
  );
}

/**
 * What the animation on its own never said.
 *
 * A live turn with nothing arriving used to render as three drifting marks
 * and no words, which reads as "typing" and is exactly wrong when the agent
 * is eight minutes into a test run. This names the step and its age, or says
 * plainly that nothing is arriving. It renders nothing at all while output
 * is flowing, because then the transcript above it is already the answer.
 */
function QuietTurnNote({
  agentPubkey,
  channelId,
}: {
  agentPubkey: string;
  channelId: string | null;
}) {
  const liveness = useAgentLiveness(agentPubkey, { channelId });
  if (
    liveness.phase !== "working-quietly" &&
    liveness.phase !== "cannot-tell"
  ) {
    return null;
  }
  return <QuietTurnNoteText state={liveness} />;
}

/**
 * The clock stops here. Only this leaf re-renders on a tick; the transcript
 * list, its rows, and the virtualised blocks above never see it.
 */
function QuietTurnNoteText({ state }: { state: AgentLivenessState }) {
  const now = useNow(NOTE_TICK_MS);
  const elapsed =
    state.sinceAt === null ? null : formatDurationMs(now - state.sinceAt);

  return (
    <p
      className="text-xs text-muted-foreground/70"
      data-liveness-phase={state.phase}
      data-testid="turn-liveness-note"
    >
      {state.phase === "cannot-tell"
        ? "No update has reached Colony"
        : (state.detail ?? "Still running")}
      {elapsed === null ? null : ` · ${elapsed}`}
    </p>
  );
}
