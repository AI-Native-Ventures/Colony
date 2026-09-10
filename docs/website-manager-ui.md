# Website Manager UI (desktop feature)

Status: source complete, not rendered or CI-verified in this session. This
document is the interface handoff for wiring the feature into existing Blocks
and for the backend/native adapter workers.

Scope: `desktop/src/features/website/**`. The feature renders inside the
existing channel message and right thread surfaces. It does not reimplement
the community rail, sidebar, composer, or thread chrome, and it never imports
demo branding or business copy.

## Surface contract

The job block is one card. The caller mounts `WebsiteJobPanel` where the job
message belongs.

| export | file | role |
| --- | --- | --- |
| `WebsiteJobPanel` | `WebsiteJobPanel.tsx` | Recommended root. Composes the five states from `record.status`. |
| `WebsiteJobCard` | `JobCard.tsx` | Quiet heading, factual status line, body, coordinator footer. |
| `WebsiteBrief` | `WebsiteBrief.tsx` | Brief content, original-site row, start action. |
| `WebsiteWorking` | `WebsiteWorking.tsx` | Stage rows plus latest revision facts. |
| `WebsiteReview` | `WebsiteReview.tsx` | Large preview, QA report, version history, decision controls. |
| `WebsiteRevision` | `WebsiteRevision.tsx` | Latest change request and whether it is addressed. |
| `WebsiteHandover` | `WebsiteHandover.tsx` | Confirmed or pending handover resources and the access-request draft. |
| `WebsitePreview` | `WebsitePreview.tsx` | Before/Redesign, desktop/mobile, version select, expanded dialog. |
| `WebsitePreviewSurface` | `WebsitePreviewSurface.tsx` | Native host anchor plus verified-capture fallback. |
| `WebsiteWorkStages` | `WebsiteWorkStages.tsx` | Divider stage rows. |
| `WebsiteQaPanel` | `WebsiteQaPanel.tsx` | Reviewer identity, result, checklist, evidence, diagnostics. |
| `WebsiteVersionHistory` | `WebsiteVersionHistory.tsx` | Every revision with builder, review result, decisions. |
| `WebsiteDecisionPanel` | `WebsiteDecisionPanel.tsx` | Exact-version approve and request-changes controls. |
| `WebsiteSourceRow` | `SourceRow.tsx` | Original website reference opened through the native bridge. |
| `WebsiteExternalLink` | `WebsiteExternalLink.tsx` | External anchor that calls `openUrl`; Electron denies new windows. |

`WebsiteJobPanel` props (`WebsiteJobPanelProps`):

- `record: WebsiteReviewRecord`, `agents: WebsiteAgentDirectory`
- `actor: string`, `communityId: string`
- `brief?: WebsiteBriefView`
- `progress?: WebsiteProgressInput | null` (canonical activity and completed stages)
- `stageAgents?: Record<string, string>` (stage definition id to pubkey)
- `onStart?: (request: WebsiteStartRequest) => Promise<void> | void`
- `onDecision?: (request: WebsiteDecisionRequest) => Promise<WebsiteDecisionReceipt | void>`
- `artifactLoader?`, `hostAdapter?`, `downloadAdapter?`, `draftAdapter?`
- `getClipBounds?: WebsiteHostBoundsProvider`
- `onOpenThread?`, `className?`

State mapping:

| status | rendered |
| --- | --- |
| `draft` | `WebsiteBrief` |
| `working` | `WebsiteRevision` (when a request exists) then `WebsiteWorking`; read-only version inspection when requested |
| `changesRequested` | `WebsiteRevision` then `WebsiteWorking`; read-only version inspection when requested |
| `readyForReview` | `WebsiteReview` |
| `approved` | `WebsiteHandover` then `WebsiteReview` |
| `handedOver` | `WebsiteHandover` then `WebsiteReview` |

## Injected adapters

| adapter | contract | unavailable behavior |
| --- | --- | --- |
| `WebsiteArtifactLoader` | Hash-verifies bytes and returns a local object URL (`blob:`, `data:`, `asset:`, `file:`, or loopback host). | Explicit error; never falls back to the remote URL. |
| `WebsitePreviewHostAdapter` | `attach` resolves a handle once the native view exists; `handle.subscribe?` streams `{status, visible, error}`. | Surface shows the verified capture with an honest notice. |
| `WebsiteArtifactDownloadAdapter` | Downloads one approved artifact through the verified native path. | Row shows "Download not available in this build". |
| `WebsiteHandoverDraftAdapter` | Returns a team-prepared request carrying its exact `scope`. | Button disabled with explicit copy. |
| `onDecision` | Dispatches the exact request and resolves with a relay receipt. | Controls disabled with "Recording a decision is not available in this build". |
| `onStart` | Dispatches the exact `{jobId, taskId, channel}` scope. | Start disabled with explicit copy. |

The native worker owns `desktop/src/shared/api/websitePreview.ts`,
`src-electron/**`, and the typed native client. The feature consumes only the
feature-side contracts in `types.ts`.

### Native handle contract

`WebsitePreviewHostHandle.setBounds` takes the two-rectangle update:

```ts
{
  element: { x, y, width, height },  // full, unclipped element rect
  clip: { top, left, right, bottom } | null,  // visible scrolling surface
  intersection: { x, y, width, height } | null,  // informational
  visible: boolean  // false when the host must render nothing
}
```

The feature never intersects before sending. The integration adapter maps
`element` to the native `bounds`, `clip` to `clip`, and converts CSS pixels
with the current webview zoom factor. When `clip` is null the UI sets
`visible` false for any partial overlap, because clipping cannot be proven.

`WebsiteNativeHandleState` is the minimal stream: `status` is
`opening | ready | failed | closed`, `visible` is true only while the native
view paints, and `error` carries a failure message. The adapter maps
`WebsitePreviewState` onto it. A ready handle with `visible: false` keeps the
verified capture on screen; a failure keeps the capture and offers a real
retry, which re-attaches even while this view already owns the preview
arbiter.

Occlusion is detected from the live DOM (`useSurfaceOcclusion`): any
`[role="dialog"]`, open menu, or Radix popper detaches the native view, and a
hidden document does the same. The expanded preview exempts exactly its own
dialog node; menus and popovers inside it still hide native content. The
inline preview is hidden while the expanded dialog is open. Occlusion only
flips `setVisible`; the view is not remounted to change visibility.

## Version inspection

While `working` or `changesRequested`, `WebsiteJobPanel` shows
`WebsiteVersionHistory`. Selecting a version opens a read-only preview of that
exact revision (`inspectionState.ts`); "Back to work" closes it, and it closes
automatically when the job leaves the working states. Decisions remain tied to
the current version only.

## QA report

`colony.website-qa-report/1` is defined by backend
`crates/buzz-core/src/website/qa_report.rs`; `qaReport.ts` mirrors its
validation (UTF-8 byte bound, code-point limits, 64-hex reviewer, public HTTPS
evidence, 1..64 unique checks, verdict agreement). The checklist is displayed
only from a fetched, hash-verified, exact revision/manifest report. If the
report is unavailable, the panel links the actual report artifact and says the
checklist is unavailable. A checklist that disagrees with `qa.passed` is
surfaced and never presented as passed. Technical fields (report event id,
hashes) live in the "Technical details" disclosure.

## Stage progress

Completion is never inferred from evidence presence, array position, or a
hash. `WebsiteProgressInput.completedStages` and `activity` must come from
typed same-task evidence or canonical task data. Until those are supplied,
brief and research rows show pending completion and no row is labelled
"working". Evidence from an earlier revision is labelled "Carried forward
from Version N". The approval row is done only when `activeApprovalId` pins an
approval to the current revision and manifest.

## Decision semantics

- `evaluateDecisionEligibility` disables both owner actions for pending,
  stale, unknown, or unauthorized selections.
- `decisionIdentityKey` excludes the note, matching the core derived decision
  id; a same-identity record with a different note resolves as
  `decision_payload_mismatch`, not success.
- A dispatch stays pending until the canonical record contains the decision.
  A relay receipt alone is not success.
- Retries re-validate the exact stored payload against the current record and
  stay disabled when stale or unauthorized.
- Request changes is allowed after `handedOver`; older approvals and handovers
  remain visible as history.
- Note limits count Unicode code points.

Local state in the brief, decision, and handover panels is scoped to
`job/task/channel` (plus actor or approved revision/hash where relevant) and
resets synchronously on a scope switch. Async results are discarded when their
dispatch scope is no longer current.

## Integration dependencies (open)

1. A worker must implement `WebsitePreviewHostAdapter` over
   `createWebsitePreviewAdapter` and map `WebsitePreviewState` events to
   `WebsiteNativeHandleState`.
2. A worker must wrap `loadWebsiteArtifact` as `WebsiteArtifactLoader` (blob
   URL preferred so `fetch` in `useQaReport` can read the report) and
   `downloadWebsiteHandover` as `WebsiteArtifactDownloadAdapter`.
3. Root wires `onDecision`, `onStart`, and `WebsiteHandoverDraftAdapter` to
   the relay and agent surfaces. The record remains the core review content;
   generation or request UUIDs belong to the integration's canonical envelope.
4. `agents`, `stageAgents`, and `progress` need canonical directory/task
   data. `completedStages` depends on the backend's typed same-task evidence
   validation.
5. `communityId` and `getClipBounds` come from the app shell so the native
   worker can refuse cross-community attaches and clip to the true scrolling
   surface.
6. Expanded-dialog native hosting depends on the adapter tolerating a
   dialog-scoped view; the UI already exempts only that dialog from occlusion.

## Tests

Authored under `desktop/src/features/website/**` as `*.test.mjs`, run by
`pnpm test` (`node --test`). Not executed in this session.

- `reviewLogic.test.mjs` authority matrix, pending/stale blocking, decision
  identity versus note, retry revalidation, code-point note limits.
- `qaReport.test.mjs` byte-versus-codepoint bounds, HTTPS evidence, empty
  checks, duplicate ids, control characters, verdict agreement, scope.
- `viewLogic.test.mjs` evidence-versus-completion, carried-forward labels,
  activity-only working state, active approval pinning, QA report scoping,
  handover labels and history, revision view.
- `previewLogic.test.mjs` two-axis fit, two-rect bounds, arbiter ownership.
- `previewHostState.test.mjs` hidden-ready, failure, closed, occlusion,
  retry-while-owning, and waiting lifecycle.
- `decisionPanelState.test.mjs`, `briefState.test.mjs`,
  `handoverState.test.mjs`, `inspectionState.test.mjs` scope resets, stale
  async guards, retry payloads, and read-only version inspection.
- `artifactVerification.test.mjs`, `useSurfaceOcclusion.test.mjs` local URL
  policy and occlusion exemption rules.

No claim of rendered, CI, or native acceptance is made here.
