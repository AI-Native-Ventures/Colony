import * as React from "react";
import { Blocks, Bot, Layers, Radar, Users } from "lucide-react";
import type { DiscoveryMentionKind } from "@/features/messages/lib/discoveryMentionRefs";
import type { TeamMentionMember } from "@/features/messages/lib/mentionCandidates";

import { Badge } from "@/shared/ui/badge";
import { cn } from "@/shared/lib/cn";
import {
  POPOVER_CUSTOM_ENTER_MOTION_CLASS,
  POPOVER_SHADOW_STYLE,
  POPOVER_SURFACE_CLASS,
} from "@/shared/ui/popoverSurface";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { safeNpub } from "@/shared/lib/nostrUtils";
import { truncatePubkey } from "@/shared/lib/pubkey";

const DISCOVERY_MENTION_LABELS: Record<string, string> = {
  industry: "Industry",
  vertical: "Vertical",
  campaign: "Campaign",
  campaign_leads: "Leads",
  lead: "Lead",
  run: "Run",
};

export type MentionSuggestion = {
  pubkey?: string;
  personaId?: string;
  teamId?: string;
  teamMembers?: TeamMentionMember[];
  blockHandle?: string;
  blockAddress?: string;
  manifestId?: string;
  cohortId?: string;
  cohortAddress?: string;
  discoveryKind?: DiscoveryMentionKind;
  entityId?: string;
  contextId?: string;
  detail?: string;
  kind?: "identity" | "persona" | "team" | "block" | "cohort" | "discovery";
  /** The token inserted into the draft and used to key the mention maps. */
  displayName: string;
  /** The alias not being inserted (role title, or personal name for a role match). */
  aliasLabel?: string | null;
  personalName?: string | null;
  roleTitle?: string | null;
  avatarUrl?: string | null;
  isAgent?: boolean;
  notInChannel?: boolean;
  ownerLabel?: string | null;
  role?: string | null;
};

type MentionAutocompleteProps = {
  suggestions: MentionSuggestion[];
  selectedIndex: number;
  onFetchMore?: () => void;
  onSelect: (suggestion: MentionSuggestion) => void;
  position?: "above" | "below";
};

export const MentionAutocomplete = React.memo(function MentionAutocomplete({
  suggestions,
  selectedIndex,
  onFetchMore,
  onSelect,
  position = "above",
}: MentionAutocompleteProps) {
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const activeItem = listRef.current?.children[selectedIndex] as
      | HTMLElement
      | undefined;
    activeItem?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleScroll = React.useCallback(() => {
    const list = listRef.current;
    if (!list || !onFetchMore) return;

    if (list.scrollHeight - list.scrollTop - list.clientHeight < 48) {
      onFetchMore();
    }
  }, [onFetchMore]);

  if (suggestions.length === 0) {
    return null;
  }

  // Name collisions are the impersonation vector: a vanity-ground key can
  // wear any display name. When two suggestions share a name, surface each
  // one's npub (truncated; full key in the hover tooltip) to tell them apart.
  const nameCounts = new Map<string, number>();
  for (const suggestion of suggestions) {
    const name = suggestion.displayName.toLowerCase();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  return (
    <div
      className={cn(
        "absolute left-0 right-0 z-50 px-3 sm:px-4",
        position === "below" ? "top-full mt-1" : "bottom-full mb-1",
      )}
    >
      <div
        className={cn(
          "max-h-48 overflow-y-auto rounded-xl p-1",
          POPOVER_CUSTOM_ENTER_MOTION_CLASS,
          position === "below"
            ? "origin-top slide-in-from-top-1"
            : "origin-bottom slide-in-from-bottom-1",
          POPOVER_SURFACE_CLASS,
        )}
        data-testid="mention-autocomplete"
        onScroll={handleScroll}
        ref={listRef}
        style={POPOVER_SHADOW_STYLE}
      >
        {suggestions.map((suggestion, index) => {
          const suggestionKey =
            suggestion.blockAddress ??
            suggestion.cohortAddress ??
            (suggestion.kind === "discovery" && suggestion.entityId
              ? `discovery-${suggestion.discoveryKind}-${suggestion.entityId}`
              : null) ??
            suggestion.pubkey ??
            (suggestion.personaId ? `persona-${suggestion.personaId}` : null) ??
            (suggestion.teamId ? `team-${suggestion.teamId}` : null) ??
            suggestion.displayName;
          const agentLabel = "agent";
          const hasNameCollision =
            (nameCounts.get(suggestion.displayName.toLowerCase()) ?? 0) > 1;
          const collisionNpub =
            hasNameCollision && suggestion.pubkey
              ? safeNpub(suggestion.pubkey)
              : null;

          return (
            <button
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm",
                index === selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "text-popover-foreground hover:bg-accent/50",
              )}
              data-testid={`mention-suggestion-${suggestionKey}`}
              key={suggestionKey}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(suggestion);
              }}
              tabIndex={-1}
              type="button"
            >
              {suggestion.kind === "block" ? (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Blocks
                    aria-hidden="true"
                    className="h-4 w-4"
                    data-testid="mention-block-icon"
                  />
                </span>
              ) : suggestion.kind === "cohort" ? (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Layers
                    aria-hidden="true"
                    className="h-4 w-4"
                    data-testid="mention-cohort-icon"
                  />
                </span>
              ) : suggestion.kind === "discovery" ? (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Radar
                    aria-hidden="true"
                    className="h-4 w-4"
                    data-testid="mention-discovery-icon"
                  />
                </span>
              ) : suggestion.kind === "team" ? (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Users aria-hidden="true" className="h-4 w-4" />
                </span>
              ) : (
                <UserAvatar
                  avatarUrl={suggestion.avatarUrl ?? null}
                  displayName={suggestion.displayName}
                  size="xs"
                  testId="mention-suggestion-avatar"
                />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className="min-w-0 break-words font-medium leading-snug"
                  title={suggestion.displayName}
                >
                  {suggestion.displayName}
                </span>
                {suggestion.kind === "block" ||
                suggestion.kind === "cohort" ||
                suggestion.kind === "discovery" ||
                suggestion.kind === "team" ||
                suggestion.isAgent ||
                suggestion.role ||
                suggestion.aliasLabel ||
                suggestion.ownerLabel ||
                suggestion.notInChannel ? (
                  <span
                    className={cn(
                      "flex min-w-0 items-center gap-1.5 text-2xs leading-none",
                      index === selectedIndex
                        ? "text-accent-foreground/60"
                        : "text-muted-foreground",
                    )}
                  >
                    {suggestion.kind === "block" ? (
                      <span className="inline-flex shrink-0 items-center gap-1">
                        <Blocks aria-hidden="true" className="h-3.5 w-3.5" />
                        Block
                      </span>
                    ) : suggestion.kind === "cohort" ? (
                      <span className="inline-flex shrink-0 items-center gap-1">
                        <Layers aria-hidden="true" className="h-3.5 w-3.5" />
                        Cohort
                      </span>
                    ) : suggestion.kind === "discovery" ? (
                      <span className="inline-flex shrink-0 items-center gap-1">
                        <Radar aria-hidden="true" className="h-3.5 w-3.5" />
                        {
                          DISCOVERY_MENTION_LABELS[
                            suggestion.discoveryKind ?? "campaign"
                          ]
                        }
                      </span>
                    ) : suggestion.kind === "team" ? (
                      <span className="inline-flex shrink-0 items-center gap-1">
                        <Users aria-hidden="true" className="h-3.5 w-3.5" />
                        team · {suggestion.teamMembers?.length ?? 0} agents
                      </span>
                    ) : suggestion.isAgent ? (
                      <span className="inline-flex shrink-0 items-center gap-1">
                        <Bot
                          aria-hidden="true"
                          className="h-3.5 w-3.5"
                          data-testid="mention-agent-icon"
                        />
                        {agentLabel}
                      </span>
                    ) : suggestion.role ? (
                      <Badge
                        className="max-w-24 shrink-0 truncate"
                        variant="secondary"
                      >
                        {suggestion.role}
                      </Badge>
                    ) : null}
                    {suggestion.aliasLabel ? (
                      <span
                        className="min-w-0 truncate"
                        data-testid="mention-alias-label"
                        title={suggestion.aliasLabel}
                      >
                        {suggestion.aliasLabel}
                      </span>
                    ) : null}
                    {suggestion.ownerLabel || suggestion.notInChannel ? (
                      <span
                        className="min-w-0 truncate"
                        title={
                          suggestion.ownerLabel && suggestion.notInChannel
                            ? `managed by ${suggestion.ownerLabel} · not in channel`
                            : suggestion.ownerLabel
                              ? `managed by ${suggestion.ownerLabel}`
                              : "not in channel"
                        }
                      >
                        {suggestion.ownerLabel && suggestion.notInChannel
                          ? `managed by ${suggestion.ownerLabel} · not in channel`
                          : suggestion.ownerLabel
                            ? `managed by ${suggestion.ownerLabel}`
                            : "not in channel"}
                      </span>
                    ) : null}
                    {suggestion.kind === "block" && suggestion.blockHandle ? (
                      <span className="min-w-0 truncate">
                        @{suggestion.blockHandle}
                      </span>
                    ) : null}
                    {suggestion.kind === "discovery" && suggestion.detail ? (
                      <span
                        className="min-w-0 truncate"
                        data-testid="mention-discovery-detail"
                        title={suggestion.detail}
                      >
                        {suggestion.detail}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {collisionNpub ? (
                  <span
                    className={cn(
                      "min-w-0 truncate font-mono text-2xs leading-snug",
                      index === selectedIndex
                        ? "text-accent-foreground/60"
                        : "text-muted-foreground",
                    )}
                    data-testid="mention-collision-npub"
                    title={collisionNpub}
                  >
                    {truncatePubkey(collisionNpub)}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
});
