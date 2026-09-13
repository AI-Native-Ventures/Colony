/**
 * Wire types for the Website Manager review protocol.
 *
 * Mirrors `crates/buzz-core/src/website/review/types.rs` and
 * `crates/buzz-core/src/website/preview.rs` (colony.website-review/1).
 * These are read-only inputs to the viewing components; nothing in this
 * directory mutates a canonical signed record.
 */

export type WebsiteJobStatus =
  | "draft"
  | "working"
  | "readyForReview"
  | "approved"
  | "changesRequested"
  | "handedOver";

export type WebsiteArtifactRef = {
  url: string;
  sha256: string;
};

/** Before, desktop and mobile captures are all required on a revision. */
export type WebsiteCaptures = {
  before: WebsiteArtifactRef;
  desktop: WebsiteArtifactRef;
  mobile: WebsiteArtifactRef;
};

export type WebsiteQaEvidence = {
  reviewer: string;
  revision: number;
  manifestSha256: string;
  passed: boolean;
  reportEventId: string;
  report: WebsiteArtifactRef;
};

export type WebsiteRevisionRecord = {
  revision: number;
  preview: WebsiteArtifactRef;
  sourceUrl: string;
  archive: WebsiteArtifactRef;
  captures: WebsiteCaptures;
  builtBy: string;
  qa?: WebsiteQaEvidence;
};

export type WebsiteDecisionKind = "approve" | "requestChanges";

/**
 * The append-only decision record. `decisionId` is derived server-side from the
 * decision content (uuidv5), so the UI never supplies it.
 */
export type WebsiteDecisionRecord = {
  decisionId: string;
  kind: WebsiteDecisionKind;
  jobId: string;
  taskId: string;
  channel: string;
  revision: number;
  manifestSha256: string;
  actor: string;
  note?: string;
};

/**
 * The exact payload a website decision dispatches into `apply_decision`. It
 * carries every scope field core re-checks, and nothing else, so a decision
 * routed to the wrong job fails closed.
 */
export type WebsiteDecisionRequest = {
  kind: WebsiteDecisionKind;
  jobId: string;
  taskId: string;
  channel: string;
  revision: number;
  manifestSha256: string;
  actor: string;
  note?: string;
};

export type WebsiteStageName =
  | "brief"
  | "research"
  | "designBuild"
  | "review"
  | "revision"
  | "approval"
  | "handover";

export type WebsiteStageEvidenceKind =
  | "jobOutcome"
  | "jobCheckpoint"
  | "taskReport"
  | "workEvent";

export type WebsiteStageEvidenceRecord = {
  stage: WebsiteStageName;
  revision?: number;
  kind: WebsiteStageEvidenceKind;
  eventId: string;
};

export type WebsiteHandoverAsset = {
  path: string;
  artifact: WebsiteArtifactRef;
};

/**
 * Canonical team-prepared domain access request. Backend-owned record content:
 * absent means not yet prepared, and the UI never composes the text itself.
 */
export type WebsiteHandoverAccessRequest = {
  text: string;
  authoredBy: string;
};

export type WebsiteHandoverRecord = {
  jobId: string;
  taskId: string;
  approvedRevision: number;
  approvedManifestSha256: string;
  sourceUrl: string;
  sourceArchive: WebsiteArtifactRef;
  assets: readonly WebsiteHandoverAsset[];
  acceptedBy: string;
  /** Present once the team has prepared the access request for this handover. */
  accessRequest?: WebsiteHandoverAccessRequest;
};

/** Exact `schema` value for review records. */
export type WebsiteReviewSchema = "colony.website-review/v1";

export type WebsiteReviewRecord = {
  schema: WebsiteReviewSchema;
  jobId: string;
  taskId: string;
  channel: string;
  threadRoot: string;
  owner: string;
  coordinator?: string;
  sourceUrl: string;
  status: WebsiteJobStatus;
  currentRevision: number;
  revisions: readonly WebsiteRevisionRecord[];
  approvals: readonly WebsiteDecisionRecord[];
  activeApprovalId?: string;
  decisions: readonly WebsiteDecisionRecord[];
  stageEvidence: readonly WebsiteStageEvidenceRecord[];
  /**
   * Handovers superseded by a later reopen/revision cycle, oldest first.
   * Omitted by the relay when empty (see `WebsiteReview.handoverHistory`).
   */
  handoverHistory?: readonly WebsiteHandoverRecord[];
  /** Most recent handover; retained as history after a later change request. */
  handover?: WebsiteHandoverRecord;
};

/**
 * Agent-authored brief content, supplied by the caller from the canonical job
 * event. The UI never composes promises or business copy itself.
 */
export type WebsiteBriefView = {
  title: string;
  summary?: string;
  /** What the manager confirmed will be preserved. */
  preserve: readonly string[];
  /** What the manager confirmed will be redesigned. */
  redesign: readonly string[];
  /** What the owner will receive. */
  delivered: readonly string[];
  note?: string;
};

/** A job agent identity rendered as name, then role beneath it. */
export type WebsiteAgentIdentity = {
  pubkey: string;
  name: string;
  role: string;
  /** Colony avatar token, e.g. "violet" | "blue" | "coral" | "green". */
  color: string;
};

export type WebsiteAgentDirectory = ReadonlyMap<string, WebsiteAgentIdentity>;

export type WebsiteStageState =
  | "done"
  | "working"
  | "next"
  | "then"
  | "blocked";

export type WebsiteStageRow = {
  id: string;
  stage: WebsiteStageName;
  label: string;
  state: WebsiteStageState;
  agent?: WebsiteAgentIdentity;
  agentFallback: string;
  detail?: string;
  /**
   * Set when every signed evidence record for this stage predates the current
   * revision. The UI labels the row as carried forward, never as new work.
   */
  carriedForwardFrom?: number;
  /** Signed evidence for this row. Empty means nothing is proven yet. */
  evidence: readonly WebsiteStageEvidenceRecord[];
};

export type WebsitePreviewViewport = "desktop" | "mobile";

export type WebsitePreviewComparison = "before" | "redesign";

/** Native site resolutions the preview is fitted from. Never cropped. */
export const WEBSITE_PREVIEW_PIXEL_SIZES: Record<
  WebsitePreviewViewport,
  { width: number; height: number }
> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

export type WebsitePreviewHostStatus =
  | "idle"
  | "waiting"
  | "unavailable"
  | "attaching"
  | "ready"
  | "error"
  | "detached";

export type WebsitePreviewHostBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Visible clip window the host must stay inside (app headers, composer). */
export type WebsiteClipBounds = {
  top: number;
  left: number;
  right: number;
  bottom: number;
};

/**
 * One bounds update for the native host: the full original element rectangle
 * plus the visible app window as a separate clip rectangle.
 *
 * The UI never intersects the two before sending. An intersection loses the
 * unclipped element geometry, which changes the host's CSS viewport and makes
 * the fitted page reflow when the card scrolls under a header. The native
 * worker owns the intersection: it renders `element` at its real size and hides
 * everything outside `clip`.
 *
 * When `clip` is null the app cannot prove the visible window, so the host must
 * render nothing unless `visible` is true. The UI sets `visible` true in that
 * case only while the whole element is inside the window; partial visibility is
 * hidden rather than guessed.
 */
export type WebsiteHostBoundsUpdate = {
  element: WebsitePreviewHostBounds;
  clip: WebsiteClipBounds | null;
  /** Element ∩ clip, or null. Informational; the host clips natively. */
  intersection: WebsitePreviewHostBounds | null;
  /** False when the host must render nothing. */
  visible: boolean;
};

export type WebsiteHostBoundsProvider = () => WebsiteClipBounds | null;

export type WebsitePreviewHostAttachRequest = {
  /** Community boundary; the native worker refuses to cross it. */
  communityId: string;
  /** Exact job the preview belongs to. */
  jobId: string;
  /** Root event id of the job thread. */
  threadRoot: string;
  /** Exact preview manifest artifact ref for the selected revision. */
  manifest: WebsiteArtifactRef;
  revision: number;
  viewport: WebsitePreviewViewport;
  /** Native CSS size the host renders before the pane fit is applied. */
  pixelWidth: number;
  pixelHeight: number;
  /**
   * Optional initial geometry so a restarted card is positioned on its first
   * frame. The full element rect travels unclipped.
   */
  bounds?: WebsitePreviewHostBounds;
  clip?: WebsiteClipBounds | null;
  /** Initial painting state; false while a dialog or hidden tab covers it. */
  visible?: boolean;
};

/**
 * Minimal native handle state the feature layer consumes. The integration
 * adapter maps `WebsitePreviewState` (`opening`/`ready`/`failed`/`closed`,
 * plus `visible` and `error`) onto this shape.
 */
export type WebsiteNativeHandleStatus =
  | "opening"
  | "ready"
  | "failed"
  | "closed";

export type WebsiteNativeHandleState = {
  status: WebsiteNativeHandleStatus;
  /** True only while the native view is actually painting. */
  visible: boolean;
  error?: string | null;
};

export type WebsitePreviewHostHandle = {
  setBounds(update: WebsiteHostBoundsUpdate): void;
  setVisible(visible: boolean): void;
  close(): void | Promise<void>;
  /**
   * Optional native state stream for this exact handle. Resolves open/ready,
   * failure, and close after the promise from `attach`. A late event from a
   * previous handle must never affect the current surface.
   */
  subscribe?(listener: (state: WebsiteNativeHandleState) => void): () => void;
};

/**
 * Adapter contract for the isolated Electron preview host.
 *
 * The UI never mounts an iframe or arbitrary URL. The native worker receives
 * the scope plus manifest artifact ref, downloads the manifest bytes, verifies
 * SHA-256, and renders the site in an isolated webContents. `attach` resolves
 * with a handle only once the view exists. The `signal` aborts a pending
 * attach when the job, revision, community, or visibility changes; a late
 * resolution must be closed by this hook.
 *
 * Boundary the UI and adapter must both uphold:
 *
 * - The native view is composited above web content, so it must never cover
 *   app chrome. `setBounds` carries the element and the clip window as two
 *   separate rectangles; the host clips against `clip` itself. The UI sets
 *   `occluded` (detaching the host) whenever a dialog, menu, expanded overlay,
 *   or other modal covers the pane. No native view is ever mounted over
 *   headers, the composer, or dialogs.
 * - Rects are CSS pixels relative to the window. Cmd +/- app zoom scales rem
 *   text via the root font-size; the adapter must convert the received CSS
 *   pixels with the current webview zoom factor so the native view stays
 *   aligned. The UI passes unzoomed layout rects.
 * - Only one host attaches to a container at a time. A second website surface
 *   that cannot own the host reports `waiting` and offers an explicit
 *   activation, never an error.
 */
export interface WebsitePreviewHostAdapter {
  attach(
    container: HTMLElement,
    request: WebsitePreviewHostAttachRequest,
    signal?: AbortSignal,
  ): Promise<WebsitePreviewHostHandle>;
  /**
   * Optional capability probe. When it resolves false the UI labels the
   * interactive preview unavailable instead of attempting to attach.
   */
  isAvailable?(): boolean | Promise<boolean>;
}

/**
 * A capture (or other artifact) whose bytes were verified locally by the
 * integration layer. `objectUrl` points at those locally verified bytes, never
 * at the remote URL, and `revoke` releases it.
 */
export type WebsiteVerifiedArtifact = {
  objectUrl: string;
  verifiedSha256: string;
  revoke: () => void;
};

/**
 * Injected adapter that downloads an artifact, verifies SHA-256 and size, and
 * returns a local object URL (`blob:`, `data:`, `asset:`, or a loopback asset
 * host). Until integration supplies a real loader the UI must show an explicit
 * "not available" state; it must never fall back to the remote URL. The UI
 * re-checks both the declared hash and the returned URL locality and refuses
 * anything else.
 */
export interface WebsiteArtifactLoader {
  load(
    artifact: WebsiteArtifactRef,
    signal?: AbortSignal,
  ): Promise<WebsiteVerifiedArtifact>;
}

/**
 * Injected adapter that downloads one handover artifact through the verified
 * native path. It receives the literal relative destination path (site asset
 * paths are canonical; the archive uses a UI-assigned filename). It must fetch
 * the exact bytes, verify SHA-256, and save them locally. The UI never sends an
 * artifact URL (or a verified blob URL) to the OS opener, and never labels the
 * remote URL itself as an approved download.
 */
export interface WebsiteArtifactDownloadAdapter {
  download(
    artifact: WebsiteArtifactRef,
    input: { path: string },
    signal?: AbortSignal,
  ): Promise<void>;
}

/**
 * Exact scope a prepared domain access request answers. Every adapter response
 * carries it so the UI can reject content prepared for another job or another
 * approved revision instead of displaying it under this one.
 */
export type WebsiteHandoverDraftScope = {
  jobId: string;
  taskId: string;
  channel: string;
  approvedRevision: number;
  approvedManifestSha256: string;
};

/**
 * A team-prepared handover request. "requested" means the preparation has not
 * returned yet; "returned" carries the team-authored draft; "failed" carries
 * the reason. The UI never composes the draft and never sends anything.
 */
export type WebsiteHandoverRequestView =
  | { status: "requested"; scope: WebsiteHandoverDraftScope }
  | {
      status: "returned";
      scope: WebsiteHandoverDraftScope;
      domain?: string;
      accessRequest?: string;
      eventId?: string;
    }
  | { status: "failed"; scope: WebsiteHandoverDraftScope; error?: string };

/** Exact scope for drafting the domain access request. */
export type WebsiteHandoverDraftRequest = WebsiteHandoverDraftScope;

/**
 * Injected adapter that asks the team to prepare a domain access request. The
 * returned draft is team-prepared; the UI verifies its declared scope before
 * displaying it and never composes or sends content itself.
 */
export interface WebsiteHandoverDraftAdapter {
  request(
    input: WebsiteHandoverDraftRequest,
    signal?: AbortSignal,
  ): Promise<WebsiteHandoverRequestView>;
}

/**
 * Receipt returned by the injected decision action once the relay has accepted
 * the signed decision event. It is not proof the review record changed: the UI
 * stays pending until the canonical record contains the matching decision.
 */
export type WebsiteDecisionReceipt = {
  eventId: string;
  decisionId?: string;
};

/**
 * Exact idempotency scope for starting a website job. Mirrors the scope fields
 * core re-checks, so a start dispatched for the wrong job fails closed.
 */
export type WebsiteStartRequest = {
  jobId: string;
  taskId: string;
  channel: string;
};

/**
 * Canonical active work for a stage, supplied by the integration from signed
 * evidence or the current task record. The UI never infers a working stage.
 */
export type WebsiteStageActivity = {
  stage: WebsiteStageName;
  detail?: string;
};

export type WebsiteProgressInput = {
  /** Canonical active work; absent means no stage may be labelled working. */
  activity?: WebsiteStageActivity | null;
  /**
   * Stages the integration has proven complete from typed, same-task evidence
   * (a completed task report/outcome or an explicit canonical completion
   * fact). Generic work-event or checkpoint presence is not completion, so the
   * UI never derives it from `stageEvidence` alone.
   */
  completedStages?: readonly WebsiteStageName[];
};
