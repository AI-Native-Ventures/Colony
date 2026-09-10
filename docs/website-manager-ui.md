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
| `WebsiteArtifactDownloadAdapter` | Downloads one approved artifact through the verified native path, with a literal relative destination path (site assets use their canonical path; the archive uses a UI-assigned filename). | Row shows "Download not available in this build". |
| `WebsiteHandoverDraftAdapter` | Returns a team-prepared request carrying its exact `scope`. Canonical `handover.accessRequest` in the record takes precedence when present. | Button disabled with explicit copy. |
| `onDecision` | Dispatches the exact request and resolves with a relay receipt. | Controls disabled with "Recording a decision is not available in this build". |
| `onStart` | Dispatches the exact `{jobId, taskId, channel}` scope. | Start disabled with explicit copy. |

The native worker owns `desktop/src/shared/api/websitePreview.ts`,
`src-electron/**`, and the typed native client. The feature consumes only the
feature-side contracts in `types.ts`.

### Native handle contract

The shared client now speaks the feature shape directly.
`WebsitePreviewHostHandle.setBounds` takes the two-rectangle update:

```ts
{
  element: { x, y, width, height },  // full, unclipped element rect
  clip: { top, left, right, bottom } | null,  // visible scrolling surface
  intersection: { x, y, width, height } | null,  // informational
  visible: boolean  // false when the host must render nothing
}
```

The feature never intersects before sending. `websiteIntegration/nativePreviewAdapter.ts`
passes the update straight to the native handle, which intersects and fits from
`element` itself. No zoom is sent: the app pins webview zoom to 1 and scales
text through the root font-size, so `getBoundingClientRect()` is already in
window coordinates.

`WebsiteNativeHandleState` is the minimal stream: `status` is
`opening | ready | failed | closed`, `visible` is true only while the native
view paints, and `error` carries a failure message. The adapter maps
`WebsitePreviewState` onto it and buffers state that arrives before the feature
subscribes, so a failed or hidden handle is never lost. A ready handle with
`visible: false` keeps the verified capture on screen; a failure keeps the
capture and offers a real retry, which re-attaches even while this view already
owns the preview arbiter. `preview_closed` and `preview_aborted` map to a
detached state rather than an error.

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
automatically when the job leaves the working states. In the thread surface the
same selection drives the decision target, so an earlier immutable version
disables both owner controls until the current version is selected again.

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

## Application integration (`desktop/src/features/websiteIntegration/`)

The feature now renders in the real channel and right thread from canonical
relay state. It is wired without touching the deferred Blocks composite path:
placement is by event id, not by composite rendering.

| file | responsibility |
| --- | --- |
| `websiteHeads.ts` | Strict head (30203) and receipt (40028) parsing, relay-self trust, generation guard, community+channel store, thread/instance indexes, receipt waiters. |
| `useWebsiteHeads.ts` | Channel-scoped query (`kinds: [30203]`, `#h`) for reload recovery plus live head/receipt subscriptions, exposed through `useSyncExternalStore`. |
| `websiteInstanceData.ts` | Parses and verifies the coordinator card's inline `website-job` data (`taskId`, `threadRoot`, `sourceUrl`, `brief`), requiring id === head `instance`, signer === head coordinator, manifest match, and record match. Supplies `WebsiteBriefView`. |
| `websiteTransport.ts` | Builds the exact reserved Block actions (`website.approve`, `website.request-changes`) and kind-40027 `beginWork`; deterministic idempotency UUID; confirms from the canonical head or a matching receipt. |
| `nativePreviewAdapter.ts` | Feature host adapter over `createWebsitePreviewAdapter`, artifact loader over `createWebsiteArtifactLoader`, handover download over `downloadWebsiteHandover`, error-code mapping. |
| `clipBounds.ts` | `useAttachmentClipBounds`: walks to the nearest scrolling ancestor (or the document scrolling element), intersects its client rect with the viewport, and returns window CSS-pixel clip bounds. Channel and thread panes each resolve their own scroller. |
| `websiteProgress.ts` | `deriveWebsiteProgress` / `deriveWebsiteStageAgents` from the relay-signed record: task report/outcome completes a stage, work event/checkpoint means in progress, revision/QA/approval/handover completion follow the record, and stage agents come only from canonical identity fields. |
| `websiteAttachments.tsx` | `WebsiteMessageAttachment`: channel root (id === head `thread`) renders the brief/working/review projection; thread card (id === head `instance`) renders QA, version history, decisions, and handover. Builds the agent directory from profiles plus the identity colour hash. |
| `resetWebsiteIntegrationState.ts` | One `resetCommunityState()` entry clearing heads, receipt waiters, and cached instance refs. |

Seams used:

- `relayClient.fetchEvents` / `subscribeLive` for heads and receipts, with the
  same `#h` channel scoping the relay expects.
- `signRelayEvent` and `relayClient.publishEvent` for kind 40027; the existing
  `submitBlockAction` publisher for decisions, so Blocks validation and the
  receipt pipeline stay the single decision path.
- `parseBlockInstance` (read-only reuse) to derive the pinned instance id and
  trust the card's data; the Blocks module is not edited.
- `useRelaySelfQuery` and `useCommunities` for the trust anchor and community
  boundary; `MessageRow.tsx` gains one import and one JSX line.
- The attachment element itself for clip bounds: the nearest computed
  `overflow-y: auto/scroll/overlay` ancestor (otherwise the document scrolling
  element) is intersected with the viewport, so no app-shell provider is
  required and the right thread clips to its own scroller.

The head confirmation is canonical: a lost receipt resolves once the head store
shows the decision or the started status. The decision panel's selected version
also drives the decision target, so selecting an earlier immutable version
disables both controls until the current version is selected again.

## Remaining gaps

1. **Shared Blocks composite.** The `website-job` core manifest renders through
   the existing Block pipeline once PR #682 lands; the integration does not
   depend on it. The inline card may show the composite fallback until then.
2. **Native Electron proof.** The browser E2E proves the DOM integration with a
   mock-only artifact loader. Real clipping, zoom, and view adoption remain the
   native worker's proof (`.github/workflows/website-preview-native-proof.yml`)
   and are not claimed here.
3. **Live agent work.** Heads, instance data, receipts, and handover access
   requests are consumed from the relay. Real crawl, build, QA, and revision
   execution belong to the backend and managed-agent workers.
4. **Progress evidence coverage.** Brief and research completion and build-stage
   activity derive from relay-validated `stageEvidence`; approval, QA, revision,
   and handover derive from the record. Any additional granularity (for example
   a research agent identity that evidence does not name) still needs canonical
   data rather than inference.
5. **Agent roles.** Role titles come from the profile directory (`role`);
   communities that do not publish kind-0 roles show "Role not recorded" rather
   than an invented title.

## Tests

Authored under `desktop/src/features/website/**` as `*.test.mjs`, run by
`pnpm test` (`node --test`). The Playwright spec runs in the smoke project.
Nothing was executed in this session.

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
- `websiteHeads.test.mjs` relay-signer trust, tag/record cross-checks,
  generation guard, instance index, receipt waiters.
- `clipBounds.test.mjs` nearest nested scroller, viewport clamping, document
  fallback, and the no-scroller null case.
- `websiteProgress.test.mjs` fresh draft, checkpoint-only in-progress,
  revision/QA completion, change-request reset, pinned approval, handover,
  and canonical-only stage agents.
- `desktop/tests/e2e/website-manager.spec.ts` (mocked proof): five states x
  1280x720 and 1440x900 screenshots asserted byte-distinct, desktop/mobile and
  Before/Redesign switching, expand and close with a dialog-count zero check,
  earlier-version inspection, stale-selection approval disabled, request
  changes failing then retrying to a canonical head confirmation, reload
  recovery, community-switch clearing, the honest browser native-unavailable
  state, and the Working stage rows showing research Done with design/build
  still in progress from a checkpoint. The spec installs the mock-only artifact
  loader described below.

Mock-only seam: `__BUZZ_E2E_WEBSITE_ARTIFACT_LOADER__` is read by
`createWebsiteArtifactLoaderAdapter`. Playwright installs fixture bytes under
their exact hashes; the feature still verifies the returned hash and local URL,
so nothing renders unverified. The packaged app never installs it.

No claim of rendered, CI, or native acceptance is made here.
