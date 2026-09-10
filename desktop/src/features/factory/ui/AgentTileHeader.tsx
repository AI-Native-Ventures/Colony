import type * as React from "react";
import {
  ChevronDown,
  CircleAlert,
  GitBranch,
  Loader2,
  RotateCw,
  Square,
  Zap,
} from "lucide-react";

import { useAcpRuntimesQuery } from "@/features/agents/hooks";
import { useUpdateManagedAgentMutation } from "@/features/agents/hooks";
import { AgentRoleSubtitle } from "@/features/agents/ui/AgentRoleSubtitle";
import { IdentityInitialsAvatar } from "@/features/agents/ui/IdentityInitialsAvatar";
import { ModelPicker } from "@/features/agents/ui/ModelPicker";
import { useManagedAgentActions } from "@/features/agents/ui/useManagedAgentActions";
import { isManagedAgentActive } from "@/features/agents/lib/managedAgentControlActions";
import { RuntimeIcon } from "@/features/onboarding/ui/RuntimeIcon";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import {
  applyEffortToEnvVars,
  resolveAgentEffortChip,
  resolveAgentHarnessChip,
  resolveAgentWorktreeLabel,
} from "@/features/factory/lib/agentTileChips";
import {
  AGENT_TILE_STATUS_LABEL,
  type AgentTileStatus,
} from "@/features/factory/lib/agentTileStatus";
import type { ManagedAgent } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

const STATUS_PILL_CLASS: Record<AgentTileStatus, string> = {
  "needs-you": "border-warning/50 bg-warning-bg text-warning",
  working: "border-primary/40 bg-primary/10 text-primary",
  idle: "border-border bg-muted/50 text-muted-foreground",
  stopped: "border-border bg-muted/40 text-muted-foreground",
  deploying: "border-warning/40 bg-warning/10 text-warning",
};

const CHIP_CLASS =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border/50 bg-muted/45 px-2.5 text-xs font-medium text-foreground";

/** The tile's identity row: who this is, what it is set to, and stop/restart. */
export function AgentTileHeader({
  agent,
  status,
}: {
  agent: ManagedAgent;
  status: AgentTileStatus;
}): React.JSX.Element {
  const runtimesQuery = useAcpRuntimesQuery();
  const harness = resolveAgentHarnessChip(agent, runtimesQuery.data ?? []);
  const runtimeEntry = harness.id
    ? (runtimesQuery.data ?? []).find(
        (candidate) =>
          candidate.id.trim().toLowerCase() === harness.id?.toLowerCase(),
      )
    : undefined;
  const worktree = resolveAgentWorktreeLabel(agent.envVars);
  const actions = useManagedAgentActions();
  const isActive = isManagedAgentActive(agent);
  const isRestarting = actions.restartingAgentPubkey === agent.pubkey;

  return (
    <div
      className="flex shrink-0 items-start gap-3 border-b border-border/60 px-3 py-2.5"
      data-testid="agent-tile-header"
    >
      <div className="h-9 w-9 shrink-0">
        {agent.avatarUrl ? (
          <ProfileAvatar
            avatarUrl={agent.avatarUrl}
            className="h-full w-full border-0 bg-muted shadow-none"
            iconClassName="h-4 w-4"
            label={agent.name}
          />
        ) : (
          <IdentityInitialsAvatar
            className="border-0 shadow-none"
            label={agent.name}
            size={36}
          />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className="min-w-0 truncate text-sm font-semibold text-foreground"
            data-testid="agent-tile-name"
          >
            {agent.name}
          </span>
          {/* The subtitle claims a whole flex line of its own, which is right
              in a message row and wrong here: wrapping it keeps the name, the
              role and the pill on one line. */}
          <span className="flex min-w-0 truncate">
            <AgentRoleSubtitle pubkey={agent.pubkey} />
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium",
              STATUS_PILL_CLASS[status],
            )}
            data-status={status}
            data-testid="agent-tile-status"
          >
            {status === "working" ? (
              <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
            ) : null}
            {status === "needs-you" ? (
              <CircleAlert aria-hidden className="h-3 w-3" />
            ) : null}
            {AGENT_TILE_STATUS_LABEL[status]}
          </span>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className={CHIP_CLASS} data-testid="agent-tile-harness-chip">
            {runtimeEntry ? (
              <RuntimeIcon className="h-3.5 w-3.5" runtime={runtimeEntry} />
            ) : null}
            <span className="truncate">{harness.label}</span>
          </span>
          <ModelPicker agent={agent} />
          <AgentEffortChip agent={agent} />
          {worktree ? (
            <span className={CHIP_CLASS} data-testid="agent-tile-worktree-chip">
              <GitBranch aria-hidden className="h-3.5 w-3.5" />
              <span className="truncate">{worktree}</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          aria-label={`Stop ${agent.name}`}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          data-testid="agent-tile-stop"
          disabled={!isActive || actions.isPending}
          onClick={() => void actions.handleStop(agent.pubkey)}
          title="Stop"
          type="button"
        >
          <Square className="h-3.5 w-3.5" />
        </button>
        <button
          aria-label={`Restart ${agent.name}`}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          data-testid="agent-tile-restart"
          disabled={actions.isPending}
          onClick={() => void actions.handleRestart(agent.pubkey)}
          title="Restart"
          type="button"
        >
          <RotateCw
            className={cn("h-3.5 w-3.5", isRestarting && "animate-spin")}
          />
        </button>
      </div>
    </div>
  );
}

/**
 * Effort chip.
 *
 * Hidden outright when the agent's provider/model advertises no effort axis —
 * an empty menu would read as a control that failed to load.
 */
function AgentEffortChip({ agent }: { agent: ManagedAgent }) {
  const { current, options } = resolveAgentEffortChip(agent);
  const updateAgent = useUpdateManagedAgentMutation();
  if (options.length === 0) return null;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(CHIP_CLASS, "hover:bg-muted/70")}
          data-testid="agent-tile-effort-chip"
          disabled={updateAgent.isPending}
          type="button"
        >
          <Zap aria-hidden className="h-3.5 w-3.5" />
          <span className="truncate">{current || "Inherit"}</span>
          <ChevronDown
            aria-hidden
            className="h-3.5 w-3.5 text-muted-foreground"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuRadioGroup
          onValueChange={(value) =>
            void updateAgent.mutateAsync({
              pubkey: agent.pubkey,
              envVars: applyEffortToEnvVars(agent.envVars, value),
            })
          }
          value={current}
        >
          <DropdownMenuRadioItem value="">Inherit</DropdownMenuRadioItem>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {option}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
