/**
 * Delegated presentation for a trusted `website-job` Block instance.
 *
 * The Block renderer renders this instead of the generic primitive tree once
 * the manifest is core-trusted. It resolves the verified head for the
 * instance event id and, when the card sits in the right thread, renders the
 * approved job body (brief facets, stages, preview, QA, history, decisions)
 * through the shared `WebsiteThreadBody`.
 *
 * In the channel timeline the generic primitive tree stays; when no verified
 * head exists yet the generic tree is kept and labelled honestly. Untrusted
 * instances never reach this component.
 */

import * as React from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import { useRelaySelfQuery } from "@/features/moderation/hooks";
import type { TimelineMessage } from "@/features/messages/types";
import { useIdentityQuery } from "@/shared/api/hooks";

import { markWebsiteCompositeRendered } from "./websiteCompositeRegistry";
import { useWebsiteHeads } from "./useWebsiteHeads";
import type { WebsiteHead } from "./websiteHeads";
import { WebsiteThreadBody } from "./WebsiteThreadBody";

function channelIdFromTags(tags: TimelineMessage["tags"]): string {
  const matches = (tags ?? []).filter(
    (tag) => tag[0] === "h" && tag.length === 2,
  );
  return matches.length === 1 ? (matches[0]?.[1] ?? "") : "";
}

function isInThreadPanel(element: HTMLElement | null): boolean {
  return Boolean(element?.closest('[data-testid="message-thread-panel"]'));
}

export default function WebsiteJobComposite({
  fallback,
  message,
}: {
  /** The manifest's own primitive tree, rendered when the body is not. */
  fallback: React.ReactNode;
  message: TimelineMessage;
}) {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const channelId = React.useMemo(
    () => channelIdFromTags(message.tags),
    [message.tags],
  );
  const relaySelf = useRelaySelfQuery(Boolean(communityId)).data ?? null;
  const identityQuery = useIdentityQuery();
  const heads = useWebsiteHeads({
    communityId: communityId || null,
    channelId: channelId || null,
    relaySelfPubkey: relaySelf ? relaySelf.toLowerCase() : null,
  });
  const head = React.useMemo<WebsiteHead | null>(
    () =>
      heads.find(
        (candidate) => candidate.instanceEventId === message.id.toLowerCase(),
      ) ?? null,
    [heads, message.id],
  );
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [inThread, setInThread] = React.useState(false);

  React.useEffect(() => {
    setInThread(isInThreadPanel(containerRef.current));
  }, []);

  // Own this instance's presentation for as long as the composite is mounted,
  // so the plain thread attachment never renders a second control set.
  React.useEffect(() => markWebsiteCompositeRendered(message.id), [message.id]);

  const showBody = Boolean(head && inThread && communityId);
  return (
    <div data-testid="website-job-composite" ref={containerRef}>
      {showBody && head && communityId ? (
        <WebsiteThreadBody
          actorPubkey={identityQuery.data?.pubkey}
          communityId={communityId}
          head={head}
          message={message}
          testId="website-job-composite-body"
        />
      ) : (
        <>
          {!head ? (
            <p className="mt-2 text-2xs text-muted-foreground">
              The website job record is still being prepared.
            </p>
          ) : null}
          {fallback}
        </>
      )}
    </div>
  );
}
