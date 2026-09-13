/**
 * The website job body rendered under the coordinator's review card.
 *
 * Shared by the plain thread attachment (event-id placement) and the delegated
 * `website-job` Block composite, so both paths render exactly the same QA,
 * version history, preview, handover, and decision controls with no drift.
 */

import * as React from "react";

import { useUsersBatchQuery } from "@/features/profile/hooks";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { useAgentRoleTitles } from "@/features/agents/useKnownAgentPubkeys";
import type { TimelineMessage } from "@/features/messages/types";
import { useIdentityQuery } from "@/shared/api/hooks";
import { cn } from "@/shared/lib/cn";

import { WebsiteDecisionPanel } from "@/features/website/WebsiteDecisionPanel";
import { WebsiteHandover } from "@/features/website/WebsiteHandover";
import { WebsitePreview } from "@/features/website/WebsitePreview";
import { WebsiteQaPanel } from "@/features/website/WebsiteQaPanel";
import { WebsiteRevision } from "@/features/website/WebsiteRevision";
import { WebsiteVersionHistory } from "@/features/website/WebsiteVersionHistory";
import { useQaReport } from "@/features/website/useQaReport";
import { resolveQaView } from "@/features/website/viewLogic";
import type {
  WebsiteArtifactDownloadAdapter,
  WebsiteDecisionReceipt,
  WebsiteDecisionRequest,
  WebsitePreviewHostAdapter,
} from "@/features/website/types";

import { useAttachmentClipBounds } from "./clipBounds";
import {
  createWebsiteArtifactLoaderAdapter,
  createWebsiteDownloadAdapter,
  createWebsiteHostAdapter,
} from "./nativePreviewAdapter";
import {
  buildWebsiteAgentDirectory,
  collectWebsiteAgentPubkeys,
} from "./websiteAgentDirectory";
import type { WebsiteHead } from "./websiteHeads";
import {
  submitWebsiteDecision,
  websiteInstanceRefFromMessage,
  type WebsiteInstanceRef,
} from "./websiteTransport";

export type WebsiteThreadBodyProps = {
  communityId: string;
  head: WebsiteHead;
  message: TimelineMessage;
  /** Message-row profiles; fetched when omitted (composite path). */
  profiles?: UserProfileLookup;
  /**
   * Current viewer pubkey from the row/thread context. Falls back to the
   * shared identity query (composite path) when the row does not provide one.
   */
  actorPubkey?: string;
  testId: string;
  className?: string;
};

export function WebsiteThreadBody({
  communityId,
  head,
  message,
  profiles: profilesProp,
  actorPubkey,
  testId,
  className,
}: WebsiteThreadBodyProps) {
  const record = head.record;
  const pubkeys = React.useMemo(() => collectWebsiteAgentPubkeys(head), [head]);
  const profilesQuery = useUsersBatchQuery(pubkeys, {
    enabled: profilesProp === undefined && pubkeys.length > 0,
  });
  const profiles = profilesProp ?? profilesQuery.data?.profiles;
  const roleTitles = useAgentRoleTitles();
  const agents = React.useMemo(
    () => buildWebsiteAgentDirectory({ profiles, head, roleTitles }),
    [head, profiles, roleTitles],
  );
  const identityQuery = useIdentityQuery();
  const actor = (actorPubkey ?? identityQuery.data?.pubkey ?? "")
    .trim()
    .toLowerCase();
  const threadRef = React.useRef<HTMLElement | null>(null);
  const getClipBounds = useAttachmentClipBounds(threadRef);
  const artifactLoader = React.useMemo(
    () => createWebsiteArtifactLoaderAdapter(communityId),
    [communityId],
  );
  const hostAdapter = React.useMemo<WebsitePreviewHostAdapter | undefined>(
    () => createWebsiteHostAdapter() ?? undefined,
    [],
  );
  const downloadAdapter: WebsiteArtifactDownloadAdapter = React.useMemo(
    () => createWebsiteDownloadAdapter(communityId),
    [communityId],
  );
  const [inspection, setInspection] = React.useState<number | null>(null);
  const revision = record.revisions.find(
    (entry) => entry.revision === record.currentRevision,
  );
  const reportState = useQaReport({ loader: artifactLoader, qa: revision?.qa });
  const qaView = resolveQaView({ revision, report: reportState });
  const instance = React.useMemo<WebsiteInstanceRef | null>(
    () =>
      websiteInstanceRefFromMessage({
        head,
        messageId: message.id,
        tags: message.tags,
      }),
    [head, message.id, message.tags],
  );
  const onDecision = React.useCallback(
    (request: WebsiteDecisionRequest): Promise<WebsiteDecisionReceipt> =>
      submitWebsiteDecision({ communityId, head, request, instance }),
    [communityId, head, instance],
  );
  const selected = inspection ?? record.currentRevision;
  const canShowDecisionControls =
    record.status !== "approved" && record.status !== "handedOver";

  // Before any revision exists there is nothing to review: no QA panel, no
  // decision form for "Version 0", no empty history. The channel card owns the
  // start action; the thread only says what will appear here.
  if (record.currentRevision === 0) {
    return (
      <section
        aria-label="Website review details"
        className={cn(
          "mt-2 overflow-hidden rounded-xl border border-border bg-card",
          className,
        )}
        data-testid={testId}
        ref={threadRef}
      >
        <p className="px-3.5 py-3 text-2xs text-muted-foreground">
          Nothing to review yet. The first version will appear here.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Website review details"
      className={cn(
        "mt-2 overflow-hidden rounded-xl border border-border bg-card",
        className,
      )}
      data-testid={testId}
      ref={threadRef}
    >
      {inspection !== null ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3.5 py-2">
            <span className="text-2xs text-muted-foreground">
              Read-only view of Version {inspection}. Decisions apply to Version{" "}
              {record.currentRevision} only.
            </span>
            <button
              className="text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => setInspection(null)}
              type="button"
            >
              Close preview
            </button>
          </div>
          <WebsitePreview
            artifactLoader={artifactLoader}
            communityId={communityId}
            getClipBounds={getClipBounds}
            hostAdapter={hostAdapter}
            onSelectRevision={setInspection}
            record={record}
            selectedRevision={inspection}
            title={`Version ${inspection} preview`}
          />
        </>
      ) : null}
      <WebsiteRevision
        agents={agents}
        onViewRevision={setInspection}
        record={record}
      />
      {record.status === "approved" || record.status === "handedOver" ? (
        <WebsiteHandover
          agents={agents}
          downloadAdapter={downloadAdapter}
          onViewRevision={setInspection}
          record={record}
        />
      ) : null}
      <WebsiteQaPanel
        agents={agents}
        artifactLoader={artifactLoader}
        reportState={reportState}
        revision={revision}
        view={qaView}
      />
      <WebsiteVersionHistory
        agents={agents}
        onSelectRevision={setInspection}
        record={record}
        selectedRevision={selected}
      />
      {canShowDecisionControls ? (
        <WebsiteDecisionPanel
          actor={actor}
          onDecision={actor ? onDecision : undefined}
          record={record}
          selectedRevision={selected}
        />
      ) : null}
    </section>
  );
}
