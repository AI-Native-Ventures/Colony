import {
  canInspectVersions,
  closeInspection,
  inspectionScopeKey,
  openInspection,
  visibleInspection,
  type WebsiteInspection,
} from "./inspectionState";
import { useRevisionSelection } from "./useRevisionSelection";
import { useScopedState } from "./useScopedState";
import { resolveRevisionView } from "./viewLogic";
import { WebsiteBrief } from "./WebsiteBrief";
import { WebsiteHandover } from "./WebsiteHandover";
import { WebsiteJobCard } from "./JobCard";
import { WebsitePreview } from "./WebsitePreview";
import { WebsiteReview } from "./WebsiteReview";
import { WebsiteRevision } from "./WebsiteRevision";
import { WebsiteVersionHistory } from "./WebsiteVersionHistory";
import { WebsiteWorking } from "./WebsiteWorking";
import type {
  WebsiteAgentDirectory,
  WebsiteArtifactDownloadAdapter,
  WebsiteArtifactLoader,
  WebsiteBriefView,
  WebsiteDecisionReceipt,
  WebsiteDecisionRequest,
  WebsiteHandoverDraftAdapter,
  WebsiteHostBoundsProvider,
  WebsitePreviewHostAdapter,
  WebsiteProgressInput,
  WebsiteReviewRecord,
  WebsiteStartRequest,
} from "./types";

export type WebsiteJobPanelProps = {
  record: WebsiteReviewRecord;
  agents: WebsiteAgentDirectory;
  /** Viewing identity for owner decision controls. */
  actor: string;
  /** Community boundary for the native preview host. */
  communityId: string;
  brief?: WebsiteBriefView;
  progress?: WebsiteProgressInput | null;
  stageAgents?: Readonly<Record<string, string>>;
  onStart?: (request: WebsiteStartRequest) => Promise<void> | void;
  onDecision?: (
    request: WebsiteDecisionRequest,
  ) => Promise<WebsiteDecisionReceipt | void>;
  artifactLoader?: WebsiteArtifactLoader;
  hostAdapter?: WebsitePreviewHostAdapter;
  downloadAdapter?: WebsiteArtifactDownloadAdapter;
  draftAdapter?: WebsiteHandoverDraftAdapter;
  getClipBounds?: WebsiteHostBoundsProvider;
  onOpenThread?: () => void;
  className?: string;
};

/**
 * The full job body: one card whose sections follow the canonical status. The
 * selected version is shared between the review preview and the handover
 * "view approved design" action, so that action opens the exact approved
 * revision rather than the original website.
 *
 * While a revision is being worked on, earlier immutable versions can be
 * opened read-only from the version history; that inspection never replaces
 * the current job state and never exposes decision controls for an old
 * version.
 */
export function WebsiteJobPanel({
  record,
  agents,
  actor,
  communityId,
  brief,
  progress,
  stageAgents,
  onStart,
  onDecision,
  artifactLoader,
  hostAdapter,
  downloadAdapter,
  draftAdapter,
  getClipBounds,
  onOpenThread,
  className,
}: WebsiteJobPanelProps) {
  const selection = useRevisionSelection(record);
  const revisionView = resolveRevisionView(record);
  const showRevision =
    record.status === "changesRequested" ||
    (record.status === "working" && revisionView.kind !== "none");
  const inspectScopeKey = inspectionScopeKey(record);
  const [inspection, setInspection] = useScopedState<WebsiteInspection>(
    inspectScopeKey,
    () => null,
  );
  const visible = visibleInspection(record, inspection);
  const inspectRevision = visible?.revision ?? null;
  const openVersion = (revision: number) =>
    setInspection((previous) => openInspection(record, previous, revision));

  return (
    <WebsiteJobCard
      agents={agents}
      brief={brief}
      className={className}
      onOpenThread={onOpenThread}
      record={record}
    >
      {record.status === "draft" ? (
        <WebsiteBrief brief={brief} onStart={onStart} record={record} />
      ) : null}

      {record.status === "working" ? (
        <>
          {showRevision ? (
            <WebsiteRevision
              agents={agents}
              onViewRevision={openVersion}
              record={record}
            />
          ) : null}
          <WebsiteWorking
            agents={agents}
            progress={progress}
            record={record}
            stageAgents={stageAgents}
          />
        </>
      ) : null}

      {record.status === "changesRequested" ? (
        <>
          <WebsiteRevision
            agents={agents}
            onViewRevision={openVersion}
            record={record}
          />
          <WebsiteWorking
            agents={agents}
            progress={progress}
            record={record}
            stageAgents={stageAgents}
          />
        </>
      ) : null}

      {canInspectVersions(record) ? (
        <>
          {visible && inspectRevision !== null ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-3.5 py-2">
                <span className="text-2xs text-muted-foreground">
                  Read-only view of Version {inspectRevision}. Decisions apply
                  to Version {record.currentRevision} only.
                </span>
                <button
                  className="text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => setInspection(closeInspection())}
                  type="button"
                >
                  Back to work
                </button>
              </div>
              <WebsitePreview
                artifactLoader={artifactLoader}
                communityId={communityId}
                getClipBounds={getClipBounds}
                hostAdapter={hostAdapter}
                onSelectRevision={openVersion}
                record={record}
                selectedRevision={inspectRevision}
                title={`Version ${inspectRevision} preview`}
              />
            </>
          ) : (
            <p className="border-t border-border px-3.5 py-2 text-2xs text-muted-foreground">
              Choose a version below to inspect it read-only.
            </p>
          )}
          <WebsiteVersionHistory
            agents={agents}
            onSelectRevision={openVersion}
            record={record}
            selectedRevision={inspectRevision ?? -1}
          />
        </>
      ) : null}

      {record.status === "readyForReview" ? (
        <WebsiteReview
          actor={actor}
          agents={agents}
          artifactLoader={artifactLoader}
          communityId={communityId}
          getClipBounds={getClipBounds}
          hostAdapter={hostAdapter}
          onDecision={onDecision}
          onSelectRevision={selection.selectRevision}
          record={record}
          selectedRevision={selection.selectedRevision}
        />
      ) : null}

      {record.status === "approved" || record.status === "handedOver" ? (
        <>
          <WebsiteHandover
            agents={agents}
            downloadAdapter={downloadAdapter}
            draftAdapter={draftAdapter}
            onViewRevision={selection.selectRevision}
            record={record}
          />
          <WebsiteReview
            actor={actor}
            agents={agents}
            artifactLoader={artifactLoader}
            communityId={communityId}
            getClipBounds={getClipBounds}
            hostAdapter={hostAdapter}
            onDecision={onDecision}
            onSelectRevision={selection.selectRevision}
            record={record}
            selectedRevision={selection.selectedRevision}
          />
        </>
      ) : null}
    </WebsiteJobCard>
  );
}
