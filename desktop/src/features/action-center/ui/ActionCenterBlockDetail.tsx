import * as React from "react";
import { Check, ExternalLink, EyeOff, RotateCcw } from "lucide-react";

import { useAppShell } from "@/app/AppShellContext";
import { useCommunities } from "@/features/communities/useCommunities";
import { useBlockManifest } from "@/features/blocks/hooks";
import { useBlockInstanceMessage } from "@/features/blocks/useBlockInstanceMessage";
import { BlockDisclosure } from "@/features/blocks/ui/BlockDisclosure";
import { BlockFallback } from "@/features/blocks/ui/BlockFallback";
import { BlockMessageBoundary } from "@/features/blocks/ui/BlockMessageBoundary";
import { Button } from "@/shared/ui/button";

import type { ActionBlockItem } from "../contracts";
import {
  blockDetailDisclosure,
  blockDismissal,
  blockStatusLine,
} from "../lib/blockActionCenter";

/**
 * Detail pane for a Block row in the Action Center.
 *
 * The card itself is the timeline's Block renderer, fed the signed instance by
 * {@link useBlockInstanceMessage}, so every gate (parse, manifest, trust,
 * supported clients, data, schema) falls back to the same plain sentence the
 * channel shows and the declared decision buttons keep the exact availability
 * and submission behaviour the timeline has. Nothing here re-decides trust.
 *
 * Dismissal writes through the AppShell's shared feed-item done state: the same
 * store the message rows use, so a hidden Block leaves every surface at once.
 * The copy comes from the capability matrix, never from a guess about what the
 * relay would accept.
 */
export function ActionCenterBlockDetail({
  item,
  onOpenSource,
}: {
  item: ActionBlockItem;
  onOpenSource?: () => void;
}) {
  const { source } = item;
  const { activeCommunity } = useCommunities();
  const { feedItemState } = useAppShell();
  const fallbackText = source.item.content;
  const instanceQuery = useBlockInstanceMessage(
    activeCommunity
      ? { communityId: activeCommunity.id, eventId: source.item.id }
      : null,
  );
  const manifestQuery = useBlockManifest(
    activeCommunity
      ? {
          communityId: activeCommunity.id,
          manifestId: source.instance.manifestId,
        }
      : null,
  );
  const manifestRecord =
    manifestQuery.data?.ok === true ? manifestQuery.data.value : null;
  const disclosure = blockDetailDisclosure(manifestRecord);
  const dismissal = blockDismissal(item.capabilities);
  const statusLine = blockStatusLine(source);
  const instanceMessage = instanceQuery.data;

  const handleDismiss = React.useCallback(() => {
    feedItemState.markDone(source.item.id);
  }, [feedItemState, source.item.id]);
  const handleUndoDismiss = React.useCallback(() => {
    feedItemState.undoDone(source.item.id);
  }, [feedItemState, source.item.id]);

  let card: React.ReactNode;
  if (!activeCommunity) {
    card = <BlockFallback state="missing" text={fallbackText} />;
  } else if (instanceQuery.isPending) {
    card = <BlockFallback state="loading" text={fallbackText} />;
  } else if (instanceQuery.isError || !instanceMessage) {
    card = <BlockFallback state="missing" text={fallbackText} />;
  } else {
    card = <BlockMessageBoundary message={instanceMessage} />;
  }

  return (
    <div
      className="min-h-full overflow-y-auto"
      data-testid="action-center-block-detail"
    >
      <section className="flex min-h-full flex-col">
        <div className="border-b border-border/60 px-5 py-5">
          <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Inline view
            {source.item.channelName ? ` · #${source.item.channelName}` : ""}
          </div>
          <h2 className="mt-2 text-lg font-semibold text-foreground">
            {item.title}
          </h2>
          <div className="mt-2 text-xs text-muted-foreground">
            {new Date(source.item.createdAt * 1_000).toLocaleString()}
          </div>
          {statusLine ? (
            <p className="mt-2 text-sm text-muted-foreground">{statusLine}</p>
          ) : null}
        </div>
        <div className="flex-1 px-5 py-5">
          {card}
          {disclosure ? (
            <BlockDisclosure
              className="mt-3"
              permissionLabels={disclosure.permissionLabels}
              untrusted={disclosure.untrusted}
            />
          ) : null}
          <div className="mt-6 flex flex-wrap gap-2">
            {onOpenSource ? (
              <Button onClick={onOpenSource} size="sm" variant="outline">
                <ExternalLink className="mr-2 size-4" />
                Open source thread
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                This view has no channel link.
              </p>
            )}
            {dismissal?.kind === "undo-done" ? (
              <Button onClick={handleUndoDismiss} size="sm" variant="ghost">
                <RotateCcw className="mr-2 size-4" />
                {dismissal.label}
              </Button>
            ) : null}
            {dismissal?.kind === "hide-locally" ? (
              <Button onClick={handleDismiss} size="sm" variant="outline">
                <EyeOff className="mr-2 size-4" />
                {dismissal.label}
              </Button>
            ) : null}
            {dismissal?.kind === "mark-done" ? (
              <Button onClick={handleDismiss} size="sm" variant="secondary">
                <Check className="mr-2 size-4" />
                {dismissal.label}
              </Button>
            ) : null}
          </div>
          {dismissal?.explanation ? (
            <p className="mt-2 max-w-[46ch] text-sm text-muted-foreground">
              {dismissal.explanation}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
