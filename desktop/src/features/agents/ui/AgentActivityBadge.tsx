import { Badge } from "@/shared/ui/badge";
import { cn } from "@/shared/lib/cn";
import { useNow } from "@/shared/lib/useNow";
import {
  formatLastActive,
  type AgentLivenessState,
} from "@/features/agents/agentLivenessState";
import { formatElapsed } from "./agentSessionUtils";

/**
 * A working badge counts in seconds, so it ticks every second. Nothing else
 * does: every other phase reads in minutes, and a second-by-second render of
 * "40 minutes ago" would be pure waste.
 */
const WORKING_TICK_MS = 1_000;
const RESTING_TICK_MS = 30_000;

const TONE_VARIANT = {
  active: "default",
  quiet: "secondary",
  warning: "warning",
  neutral: "secondary",
} as const;

/**
 * The agent's state as one badge.
 *
 * The clock lives in a child that only mounts when there is genuinely
 * something to count, and it is the only thing that re-renders on a tick. The
 * badge, the row it sits in, and the list above it never see the clock at
 * all. That is the same shape `AskDeadlineNote` uses, and the reason an app
 * full of idle agent rows costs no intervals.
 *
 * There is no spinner and no progress bar here on purpose. Every number this
 * renders is the age of a real signal.
 */
export function AgentActivityBadge({
  className,
  state,
  channelLabel,
}: {
  className?: string;
  state: AgentLivenessState;
  /** Channel name to name in a working badge, e.g. "general". */
  channelLabel?: string | null;
}) {
  if (state.phase === "idle") return null;

  const variant = TONE_VARIANT[state.tone];
  const working = state.phase === "working";

  return (
    <Badge
      className={cn(
        "normal-case tracking-normal",
        working && "motion-safe:animate-pulse",
        className,
      )}
      data-liveness-phase={state.phase}
      data-testid="agent-activity-badge"
      title={state.detail ?? undefined}
      variant={variant}
    >
      {working && channelLabel ? `Working in #${channelLabel}` : state.label}
      {state.sinceAt === null || state.sinceKind === null ? null : (
        <AgentActivityElapsed
          sinceAt={state.sinceAt}
          sinceKind={state.sinceKind}
        />
      )}
    </Badge>
  );
}

/**
 * The live half of the badge, isolated so the tick stops here.
 *
 * "Working for" counts up in seconds because the owner is watching something
 * happen. "Last active" is coarse and past-tense because the underlying
 * signals -- a ten second liveness ping, a three minute presence TTL --
 * cannot support anything finer, and a seconds display would claim they can.
 */
function AgentActivityElapsed({
  sinceAt,
  sinceKind,
}: {
  sinceAt: number;
  sinceKind: NonNullable<AgentLivenessState["sinceKind"]>;
}) {
  const working = sinceKind === "working-for";
  const now = useNow(working ? WORKING_TICK_MS : RESTING_TICK_MS);

  return (
    <span data-testid="agent-activity-elapsed">
      {" · "}
      {working
        ? formatElapsed(now - sinceAt)
        : `last active ${formatLastActive(now - sinceAt)}`}
    </span>
  );
}

/**
 * The sentence under the badge. Renders nothing when the badge already says
 * everything, which is the common case for a working agent.
 */
export function AgentActivityDetail({
  className,
  state,
}: {
  className?: string;
  state: AgentLivenessState;
}) {
  if (state.detail === null) return null;
  return (
    <p
      className={cn(
        "text-xs",
        state.tone === "warning"
          ? "text-amber-600 dark:text-amber-400"
          : "text-muted-foreground",
        className,
      )}
      data-testid="agent-activity-detail"
    >
      {state.detail}
    </p>
  );
}
