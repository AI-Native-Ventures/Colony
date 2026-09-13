# Website Manager implementation plan

> Execution: GPT-5.6 Luna workers with `max` reasoning. The root agent owns orchestration, design review, integration and GitHub operations. The root does not write product implementation code.

**Goal:** Deliver the approved Website Manager experience in real Colony threads: a brief, delegated Studio Method work, substantial before/redesign previews, real revisions, version-bound owner review and an approved handover.

**Architecture:** Reuse company tasks and the job broker for execution. Extend the existing Blocks grammar and signed action path for presentation and decisions. Add a narrowly scoped durable review record where current Block data cannot enforce version identity and action ordering. Website creation remains agent work through bundled, editable skills. No second workflow engine, simulated progress, generic HTML renderer, or hardcoded client design.

**Reference:** [Approved design](../specs/2026-09-10-website-manager-design.md), [proof matrix](../specs/2026-09-10-website-manager-proof.md), [Studio Method](../specs/2026-09-10-website-studio-method.md).

> Current checkpoint (2026-09-12): the Website Manager source slice now includes the visual/native corrections, immutable public-fixture relay lifecycle coverage, and bundled employee runbook/install work through candidate commit `37d7f748a`. Hosted evidence remains scoped to its exact source heads: the mock UI run at `448196b306f7318cf9e8a717c681c9e647a28b8b` passed 9 mock UI cases and produced 10 distinct rendered screenshots, while the hosted relay evidence at `91208cba01d72b3225e2be1c3120be8e2488afbd` passed 7 relay cases. The current native preview source is based on `e671aa6e9`; its native proof is still pending. The newly added lifecycle/runbook source needs current-head CI, and managed-agent adoption plus the authenticated/live Website Manager flow remain unproven.

Implementation and proof are separate at this checkpoint. The source slices are present where marked below, but a checkbox stays open when the required exact-head CI, native rendering, installed-runtime, or real managed-agent observation has not passed.

## Phase 1: shared contract, isolated preview and team recipe

Acceptance gate: reviewed source establishes one consistent preview artifact/review contract, a real interactive isolated preview implementation, and portable team skills. This gate does not establish workflow completion or authorize a release.

- [x] Preserve the approved visual and separate worktree on current develop.
- [x] Inspect existing tasks, job leases, Blocks, signed actions and agent staffing.
- [x] Confirm PR #682 owns the shared Blocks redesign; consume it after landing without duplicating existing media renderers.
- [ ] Backend worker: add `crates/buzz-core/src/website.rs` with documented types and pure validation for preview artifacts, immutable revisions and owner review decisions; export it from `lib.rs`. Add shared JSON vectors under `crates/buzz-core/testdata/website/`.
- [ ] Backend worker: define the exact serialized contract in `docs/website-manager-protocol.md`. Keep job IDs, task ID, channel/thread, owner and coordinator identity explicit. Stage data references existing job heads; claims of progress alone are not evidence. Keep prior revisions and the approved artifact digest.
- [ ] Backend worker: meaningful unit cases for wrong owner/scope, mismatched digest, stale revision, duplicate/conflicting decisions, missing independent review evidence and revisions following approval. Do not run them locally.
- [ ] Preview worker: implement a dedicated ephemeral Electron preview host under `desktop/src-electron/website-preview/`. Do not reuse `BrowserViews.sessionFor`, which contains signed-in business cookies. Use sandbox, no Node/preload/privileged IPC, deny permissions/downloads/popups, and restrict navigation/resource loading to the pinned preview artifact.
- [ ] Preview worker: verify a bounded manifest and every loaded file's digest before rendering. Reject traversal, duplicate paths, oversized assets, remote redirects to privileged/private locations and incomplete bundles. Release views/sessions on close/community change. Preserve exact desktop/mobile viewport semantics when fitting inline/expanded panes.
- [ ] Team worker: add a portable Website Manager persona pack with manager, researcher, fused designer-builder and independent reviewer roles plus actual job skills. Use the existing persona-pack format and supported Colony CLI/browser/filesystem capabilities. No developer-machine paths or silent provider/deployment-account changes.
- [ ] Team worker: document a precise idempotent integration path through the existing persona/team installation APIs. Preserve unrelated user-customized agents; provisioned core employees must exist, cannot be deleted, adopt the current role holder, and receive updated bundled configuration on reconciliation.

### Preview artifact contract to share

Use an immutable JSON manifest identified by its SHA-256. It lists a relative entrypoint and bounded files, each with a normalized relative path, media URL, MIME type, size and SHA-256. Source/archive and before/desktop/mobile captures are separate immutable references. The manifest and all file bytes are verified; a mutable URL is not version identity. Do not embed megabytes of HTML or base64 media in a Block's 32 KiB data envelope. The preview must render the real artifact interactively, not a screenshot substitute. A captured original may be shown as the factual before reference.

Use one shared schema/vector set across Rust, native JavaScript and TypeScript. The backend worker writes the precise schema first; the other workers consume that file before finalizing wire-format details. Protocol fields are small, explicit and versioned; limits and invalid cases belong in that contract.

## Phase 2: connect durable work, Blocks and owner actions

Acceptance gate: a job can be created, advanced by real worker outcomes, revised and reviewed through existing signed event infrastructure. Duplicate actions and stale approvals are rejected atomically. Recovery returns the same work.

- [ ] Extend the relay through Nostr kinds/actions in `crates/buzz-core/src/kind.rs` and a focused broker module. Reuse current tenant/channel/member verification, signing, task/job APIs and atomic database patterns. Choose new kind values only after checking the registry. No new bespoke HTTP API.
- [ ] Persist the current review revision and accepted decision atomically with its event/receipt. A read-then-write check without concurrency protection is insufficient. One idempotency key must not create multiple revision jobs. A failed publication must not leave an accepted state without its event.
- [ ] Connect dispatch to actual managed-agent execution. ACP currently wakes agents on signed thread mentions and routes signed Blocks actions to their processor. `buzz jobs work` is a separate direct-LLM loop, and job claims are owner-only. Merely filing a queue row does not start a managed worker. Keep owner keys out of agent processes. Reuse assigned-agent `KIND_TASK_REPORT` and canonical CompanyTask state where applicable, or add an explicit owner-side adapter for queue leases; prove the selected path actually runs the managed worker and records its signed artifacts. Do not weaken existing claim authority or document agent-owned lease commands as operational when they are not.
- [ ] Add the agent-facing operation to `crates/buzz-cli/src/commands/` and command registration/client helpers. Support preparing and posting artifact manifests, querying the durable record, attaching existing job outcome evidence, and resuming work from current state. Keep event scope explicit.
- [ ] Add a reviewed `website-job` composite under `crates/buzz-relay/src/core_blocks/composites/`, register it in `core_blocks.rs`, and preserve immutable previous manifest digests. Add only the missing bounded preview/stage capabilities to the existing Block grammar.
- [ ] Frontend worker: extend `features/blocks/contracts.ts`, validation and `ui/primitives/BlockPrimitive.tsx` through the existing registry. Add new focused Website Preview and stage components. Keep image/video/document viewing in the shared PR #682 components.
- [ ] Frontend worker: wire current job head, exact revision, pending/error/receipt state and signed action inputs through `BlockMessage` / `BlockRenderContext`. Do not create a second submission path, fake local success, separate job dashboard or unrelated thread.
- [ ] Add Before/Redesign, desktop/mobile, expansion, version selection, QA details, a genuine revision request and owner approval. Older versions remain inspectable but cannot be used to approve newer work. Handover exposes approved source/assets and a draft domain-access request; it never publishes the website itself.
- [ ] Connect the bundled team to an ordinary-language starter in the actual agent/team UI. Scope installation and dispatch to the active community and selected channel/thread; inherit Power defaults; provisioned core employees must exist, cannot be deleted, adopt the current role holder, and receive updated bundled configuration, while unrelated customized agents remain preserved.

## Phase 3: GitHub checks and rendered proof

Acceptance gate: all proof-matrix rows have matching evidence from the exact candidate head. A green PR is not sufficient by itself.

- [ ] Add desktop Playwright cases in `desktop/tests/e2e/website-manager.spec.ts` and register them in the smoke project's `testMatch`. Use the E2E bridge and animation helper. Retain five distinct rendered state screenshots, including the adjacent channel/thread and community rail.
- [ ] Add native preview host tests beside the implementation for cookies/session separation, malicious URLs/paths, integrity mismatch, popup/navigation denial, viewport changes and lifecycle cleanup.
- [ ] Add relay integration coverage for atomic revision/approval races, wrong owner/community, retry after interrupted work, stale approvals and exact action/receipt/artifact identity. Ensure tests would fail if the guards are removed; demonstrate this via CI, not local execution.
- [ ] Commit with DCO signoff, push a develop-targeted PR and use GitHub CI for lint, unit tests, Desktop/desktop smoke, native proof and relay suites. Do not run local CI, builds, tests, formatters, dependency installs or CI hooks.
- [ ] Inspect CI-rendered artifacts at the approved reference widths. Compare Brief, Working, Review, Revision and Handover against the original concept, not a newly simplified reference. Ask workers to correct any material differences.
- [ ] Run the real Website Manager flow against an authorized public test website: research, improved design/build, independent review, preview, owner revision and handover preparation. Record actual agent traces and artifact digests, not mocked replies.
- [ ] Coordinate with the shared Blocks release task before enqueueing overlapping changes or choosing a production version. Arm auto-merge only within repository gates. Keep merge, package publication, installed runtime and live acceptance as distinct reported states.

## Worker execution rules

Assignments are narrow and ownership is explicit. Read focused source ranges; avoid whole-repository discovery or oversized session context. Keep model and effort pinned. Each worker reports changed files, exact invariants implemented and remaining gaps. Root performs specification review and code review before integration, and delegates fixes back to the workers. No silent fallback to a different model or hand-written root implementation.
