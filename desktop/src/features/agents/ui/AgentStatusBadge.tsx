import * as React from "react";

import { Badge } from "@/shared/ui/badge";
import type { ManagedAgent, PresenceStatus } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import type { AgentLivenessState } from "@/features/agents/agentLivenessState";
import { AgentActivityBadge } from "./AgentActivityBadge";

/** Grace period after mount before treating "running + no presence" as "Starting…" */
const PRESENCE_GRACE_MS = 15_000;

export function AgentStatusBadge({
  className,
  liveness,
  presenceLoaded,
  presenceStatus,
  sentenceCase = false,
  status,
}: {
  className?: string;
  /**
   * Turn-derived state. When the agent has anything to say about its work --
   * working, quiet, not responding, offline, no signal -- this wins outright,
   * because process lifecycle cannot answer any of those questions. The old
   * `isWorking` boolean this replaces could only ever say Working or not, and
   * "not" silently became the process status, which is how a stuck agent came
   * to render as a healthy one.
   */
  liveness?: AgentLivenessState;
  presenceLoaded: boolean;
  presenceStatus: PresenceStatus | undefined;
  sentenceCase?: boolean;
  status: ManagedAgent["status"];
}) {
  const [inGracePeriod, setInGracePeriod] = React.useState(true);

  React.useEffect(() => {
    const timer = setTimeout(() => setInGracePeriod(false), PRESENCE_GRACE_MS);
    return () => clearTimeout(timer);
  }, []);

  // Idle is the one phase with nothing of its own to report, so it hands back
  // to the process/presence rendering below rather than replacing it.
  if (liveness && liveness.phase !== "idle") {
    return <AgentActivityBadge className={className} state={liveness} />;
  }

  const isActive = status === "running" || status === "deployed";
  const isStarting =
    !inGracePeriod &&
    presenceLoaded &&
    status === "running" &&
    (!presenceStatus || presenceStatus === "offline");

  const variant: "default" | "warning" | "secondary" = isStarting
    ? "warning"
    : isActive
      ? "default"
      : "secondary";

  const rawLabel = isStarting ? "Starting…" : status.replace(/_/g, " ");
  const label = sentenceCase
    ? `${rawLabel.charAt(0).toUpperCase()}${rawLabel.slice(1)}`
    : rawLabel;

  return (
    <Badge className={cn(className)} variant={variant}>
      {label}
    </Badge>
  );
}
