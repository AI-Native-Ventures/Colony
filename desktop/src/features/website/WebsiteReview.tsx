import { cn } from "@/shared/lib/cn";

import { useQaReport } from "./useQaReport";
import { useRevisionSelection } from "./useRevisionSelection";
import { resolveQaView } from "./viewLogic";
import { WebsiteDecisionPanel } from "./WebsiteDecisionPanel";
import { WebsitePreview } from "./WebsitePreview";
import { WebsiteQaPanel } from "./WebsiteQaPanel";
import { WebsiteVersionHistory } from "./WebsiteVersionHistory";
import type {
  WebsiteAgentDirectory,
  WebsiteArtifactLoader,
  WebsiteDecisionReceipt,
  WebsiteDecisionRequest,
  WebsiteHostBoundsProvider,
  WebsitePreviewHostAdapter,
  WebsiteReviewRecord,
} from "./types";

export type WebsiteReviewProps = {
  record: WebsiteReviewRecord;
  agents: WebsiteAgentDirectory;
  /** Viewing identity for the decision controls. */
  actor: string;
  /** Community boundary for the native preview host. */
  communityId: string;
  /** Controlled version selection; omit to let the block manage it. */
  selectedRevision?: number;
  onSelectRevision?: (revision: number) => void;
  onDecision?: (
    request: WebsiteDecisionRequest,
  ) => Promise<WebsiteDecisionReceipt | undefined>;
  artifactLoader?: WebsiteArtifactLoader;
  hostAdapter?: WebsitePreviewHostAdapter;
  getClipBounds?: WebsiteHostBoundsProvider;
  /** Independent review panel. The channel root renders the preview only. */
  showQaPanel?: boolean;
  /** Version history. Rendered by the thread surface, not the root. */
  showVersionHistory?: boolean;
  /** Owner decision controls. Rendered by the thread surface only. */
  showDecisionControls?: boolean;
  className?: string;
};

/**
 * The review state: the large versioned preview, the independent review panel
 * (checklist from the fetched exact-revision report), version history, and the
 * owner decision controls. Every claim comes from the record, the report
 * artifact, or an injected adapter.
 */
export function WebsiteReview({
  record,
  agents,
  actor,
  communityId,
  selectedRevision,
  onSelectRevision,
  onDecision,
  artifactLoader,
  hostAdapter,
  getClipBounds,
  showQaPanel = true,
  showVersionHistory = true,
  showDecisionControls = true,
  className,
}: WebsiteReviewProps) {
  const selection = useRevisionSelection(record);
  const currentSelection = selectedRevision ?? selection.selectedRevision;
  const selectRevision = onSelectRevision ?? selection.selectRevision;
  const revision = record.revisions.find(
    (entry) => entry.revision === currentSelection,
  );
  const reportState = useQaReport({
    loader: artifactLoader,
    qa: revision?.qa,
    enabled: showQaPanel,
  });
  const qaView = resolveQaView({ revision, report: reportState });

  return (
    <section
      aria-label="Design review"
      className={cn("flex flex-col", className)}
    >
      {selectedRevision === undefined && selection.notice ? (
        <p
          aria-live="polite"
          className="border-b border-border bg-muted/30 px-3.5 py-2 text-2xs text-muted-foreground"
        >
          {selection.notice}
        </p>
      ) : null}
      <WebsitePreview
        artifactLoader={artifactLoader}
        communityId={communityId}
        getClipBounds={getClipBounds}
        hostAdapter={hostAdapter}
        onSelectRevision={selectRevision}
        record={record}
        selectedRevision={currentSelection}
      />
      {showQaPanel ? (
        <WebsiteQaPanel
          agents={agents}
          artifactLoader={artifactLoader}
          reportState={reportState}
          revision={revision}
          view={qaView}
        />
      ) : null}
      {showVersionHistory ? (
        <WebsiteVersionHistory
          agents={agents}
          onSelectRevision={selectRevision}
          record={record}
          selectedRevision={currentSelection}
        />
      ) : null}
      {showDecisionControls ? (
        <WebsiteDecisionPanel
          actor={actor}
          onDecision={onDecision}
          record={record}
          selectedRevision={currentSelection}
        />
      ) : null}
    </section>
  );
}
