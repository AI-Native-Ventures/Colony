import type { AgentRank } from "@/features/agents/employeeHeads";
import { rankLabel } from "@/features/agents/employeeHeads";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";

/**
 * An agent's rank in the interrupt ladder, in plain language.
 *
 * Renders nothing for an untiered agent: callers pass `null` (no employee
 * head) and get no badge rather than an invented default rank.
 */

const RANK_VARIANTS: Record<AgentRank, "secondary" | "info" | "default"> = {
  worker: "secondary",
  leader: "info",
  executive: "default",
};

type AgentRankBadgeProps = {
  rank: AgentRank;
  className?: string;
  testId?: string;
};

export function AgentRankBadge({
  rank,
  className,
  testId = "agent-rank-badge",
}: AgentRankBadgeProps) {
  return (
    <Badge
      className={cn("shrink-0 normal-case tracking-normal", className)}
      data-testid={testId}
      variant={RANK_VARIANTS[rank]}
    >
      {rankLabel(rank)}
    </Badge>
  );
}
