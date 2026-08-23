import { ExternalLink } from "lucide-react";

import type { ActionAskSource } from "../contracts";
import { AskResolutionNotice } from "@/features/asks/ui/AskResolutionNotice";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";

/**
 * Detail view for an ask that a resolution already closed.
 *
 * Read-only by design: the ask is answered or executed, so there is no
 * form here, only the account of what happened and the path back to the
 * thread it came from. An executed default renders with its own label and
 * tone, naming the option the relay applied on the owner's silence.
 */
export function ActionCenterResolvedAskDetail({
  onOpenSource,
  source,
}: {
  onOpenSource?: () => void;
  source: ActionAskSource;
}) {
  const { resolution } = source;
  const isDefault = resolution?.defaultExecuted === true;
  const resolverPubkey =
    !isDefault && resolution ? resolution.resolverPubkey : null;
  // Hooks stay above any early return so the component can go from
  // "resolution not yet attached" to attached without a hook-order change.
  const labelsQuery = useUsersBatchQuery(
    resolverPubkey ? [resolverPubkey] : [],
    {
      enabled: resolverPubkey !== null,
    },
  );
  if (!resolution) return null;
  const profile =
    labelsQuery.data?.profiles[normalizePubkey(resolution.resolverPubkey)];
  const resolverLabel = isDefault
    ? null
    : profile?.displayName?.trim() ||
      truncatePubkey(normalizePubkey(resolution.resolverPubkey));

  return (
    <div
      className="min-h-full overflow-y-auto"
      data-testid="action-center-resolved-ask-detail"
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-muted-foreground">
            Ask · {source.ask.askType}
          </span>
          <h2 className="text-base font-medium text-foreground">
            {source.ask.headline}
          </h2>
          {source.ask.costOfDelay ? (
            <p className="text-sm text-muted-foreground">
              Waiting costs: {source.ask.costOfDelay}
            </p>
          ) : null}
        </div>
        <AskResolutionNotice
          resolution={resolution}
          resolverLabel={resolverLabel}
        />
        {source.ask.channelId && source.ask.threadId && onOpenSource ? (
          <div className="border-t border-border/60 pt-4">
            <Button onClick={onOpenSource} size="sm" variant="outline">
              <ExternalLink className="mr-2 size-4" />
              Open source thread
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
