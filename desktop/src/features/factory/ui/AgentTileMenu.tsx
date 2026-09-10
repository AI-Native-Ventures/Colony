import type * as React from "react";
import { MoreHorizontal, Plus, RotateCw, Square, Terminal } from "lucide-react";

import { useManagedAgentActions } from "@/features/agents/ui/useManagedAgentActions";
import { isManagedAgentActive } from "@/features/agents/lib/managedAgentControlActions";
import type { FactoryTileActions } from "@/features/factory/ui/FactoryTileContext";
import type { ManagedAgent } from "@/shared/api/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

/**
 * The tile's overflow menu: where this agent works, who it can hand work to,
 * and its two lifecycle controls.
 *
 * `actions` is null for a tile that has been dragged out of the Factory. The
 * menu still opens — stop and restart are properties of the agent, not of the
 * canvas — but the two canvas-bound items disable themselves rather than
 * disappearing, so the menu does not change shape depending on where the tile
 * happens to be docked.
 */
export function AgentTileMenu({
  actions,
  agent,
  delegates,
  onDelegate,
  onNewDelegate,
  onOpenTerminal,
}: {
  actions: FactoryTileActions | null;
  agent: ManagedAgent;
  /** The other agents this one may hand work to. */
  delegates: ReadonlyArray<{ pubkey: string; name: string }>;
  onDelegate: (delegate: { pubkey: string; name: string }) => void;
  onNewDelegate: () => void;
  onOpenTerminal: () => void;
}): React.JSX.Element {
  const agentActions = useManagedAgentActions();
  const isActive = isManagedAgentActive(agent);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`More actions for ${agent.name}`}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          data-testid="agent-tile-menu"
          title="More"
          type="button"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem
          data-testid="agent-tile-open-terminal"
          disabled={actions === null || !agent.workingDir}
          onSelect={onOpenTerminal}
        >
          <Terminal aria-hidden className="mr-2 h-3.5 w-3.5" />
          Open terminal here
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            data-testid="agent-tile-delegate-trigger"
            disabled={actions === null}
          >
            Delegate to…
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-48">
            {delegates.map((candidate) => (
              <DropdownMenuItem
                data-testid={`agent-tile-delegate-${candidate.pubkey}`}
                key={candidate.pubkey}
                onSelect={() => onDelegate(candidate)}
              >
                {candidate.name}
              </DropdownMenuItem>
            ))}
            {delegates.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              data-testid="agent-tile-delegate-new"
              onSelect={onNewDelegate}
            >
              <Plus aria-hidden className="mr-2 h-3.5 w-3.5" />
              New agent…
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="agent-tile-menu-restart"
          disabled={agentActions.isPending}
          onSelect={() => void agentActions.handleRestart(agent.pubkey)}
        >
          <RotateCw aria-hidden className="mr-2 h-3.5 w-3.5" />
          Restart
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="agent-tile-menu-stop"
          disabled={!isActive || agentActions.isPending}
          onSelect={() => void agentActions.handleStop(agent.pubkey)}
        >
          <Square aria-hidden className="mr-2 h-3.5 w-3.5" />
          Stop
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
