# Onboarding: verified agent response and personal history

Status: approved design, implemented in `codex/onboarding-history-response-gate` from integration base `688bfa41b`. Native compilation and installed-app proof remain outstanding.

## Implemented scope

PowerScreen persists configuration before a correlated Chief of Staff response test. History follows success. Discovery supports Codex/Claude JSONL, legacy OpenClaw JSONL and Hermes CLI SQLite history. ChatGPT/Claude JSON exports are selected explicitly. Other formats are labelled unsupported; arbitrary folder selection is not implemented.

Drafts extract explicit user statements locally. Owners review/edit/exclude before encrypted engram writes. Raw transcripts remain local. OpenClaw and markdown entries require selection because attribution can be uncertain. Review state lasts while mounted; writes are retry-safe. Scans are bounded, so counts may be partial.

Component checks covered 1280×720 and 390×844 with synthetic data. Sixteen focused browser flow checks passed, including fresh signup and additional businesses. No personal transcripts were read. Native fixture tests await hosted CI.

References: [Hermes storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage), [OpenClaw sessions](https://docs.openclaw.ai/concepts/session). Codex icon is copied from the approved mockup asset, originally the local ChatGPT application's Codex icon. Other logos reuse project assets.

The sections below retain original design intent; this scope records implementation boundaries.

## Product outcome

A new owner enters Colony with a working agent and useful, owner-approved context from previous AI conversations. Colony visibly performs discovery, extraction, and memory creation during onboarding.

The four user-facing stages are Account, Business, Connect and test, and Get to know you. Recovery remains within Account; workspace provisioning and website reading remain within Business; any necessary funding remains within Connect and test. Internal substates do not become extra numbered stages.

## Findings in the inspected checkout

- `desktop/src/features/onboarding/ui/new/screens/BrainScreen.tsx` derives Continue from catalog readiness, key shape, or an unconditional Colony selection. It does not wait for a generated reply.
- `desktop/src/features/onboarding/ui/new/NewOnboardingFlow.tsx` calls `applyBrainChoice` without awaiting completion, logs write failures, and advances immediately.
- `desktop/src/shared/api/tauriSubscriptions.ts` and the native subscription command discover harness installations and account metadata; they are not conversation importers.
- `desktop/src/features/onboarding/welcomeKickoff.ts` already contains managed-agent startup, message delivery, reply observation, and welcome-team coordination primitives. Reuse those production paths for the onboarding test.
- These findings describe the inspected checkout, not the installed desktop build or latest integration branch. Reconcile with the current integration branch before implementation.

## Step 3: Connect and test

After installation/sign-in or key entry, await configuration persistence and resolve the same effective configuration the actual onboarding agent will use. Show Saving, Starting your agent, Waiting for a reply, and Agent replied as distinct states.

Create or reuse the actual initial agent through existing provisioning machinery, subscribe before dispatch, then send a small owner-initiated test through the normal Colony relay and agent execution path. Show the returned assistant text directly in this screen. A process start, authenticated catalog entry, presence event, typing event, tool output, or echoed user message cannot pass the gate.

Bind success to the owner, workspace, selected adapter, effective configuration revision, agent identity, request/thread identity, and successful completed turn containing a nonempty assistant reply. A stale reply or late result from a cancelled attempt cannot pass a newer test. No provider fallback may silently validate a different selection.

Keep Continue disabled until this succeeds. Recheck the configuration revision at final handoff; changing the model, adapter, credential context, or workspace invalidates proof. Onboarding resume reruns verification instead of trusting a persisted boolean.

Surface save errors, missing login, unavailable model, exhausted quota, startup failure, relay failure, empty/error completion, and bounded timeout in plain language. Example: “This configuration isn't working yet. Your agent didn't reply.” Offer Retry, reconnect where supported, and Choose another option. Preserve account and business answers. Safe repairs use existing install/reconnect paths; do not repeatedly retry billable requests or change the user's provider silently.

Use a 120-second overall response deadline, cancellable immediately. Cancel obsolete subscriptions and test turns on selection change, leaving, or unmount. Reuse the provisioned initial agent at handoff; do not leave test agents or duplicate welcome prompts behind.

If the selected route requires credits, funding must be available before testing within this stage. Show that the short test uses the selected account. Validate metered usage against the existing ledger in acceptance testing. A successful test proves this configuration worked at that moment, not permanent provider availability or every future tool action.

## Step 4: Let Colony get to know you

Explain before scanning: “Colony can find previous AI conversations on this computer and turn what you've already shared into memories. You choose what to use.” Offer Find my history, Choose an export or folder, and Skip for now.

Discovery checks supported application data locations and configured roots for local agent transcripts and memory files. It reports sources and metadata before reading conversation bodies for extraction. Start with Codex and Claude Code; add other installed agents through explicit source readers whose formats are validated with fixtures. App detection alone never means history was found. Do not promise a universal parser for arbitrary agent files.

Treat ChatGPT and Claude desktop histories as distinct sources from Codex and Claude Code. If a readable supported local store is unavailable, show “Choose a ChatGPT/Claude export” instead of claiming cloud conversation access. Verify actual formats during implementation. Unsupported stores and permission-denied paths get explicit statuses; the owner can select additional folders. No whole-disk crawl or credential-store scraping.

Show source name, location, available conversation counts/date range when measurable, and selection controls. Before processing, explain that selected conversation text will be sent to the configured AI provider when extraction uses that provider. The owner must select sources and choose Create my memories; finding files alone does not authorize transmission.

Show progress as Finding history, Reading selected conversations, Drafting memories, and Review. Extract useful user-stated preferences, business context, ongoing projects, goals, and working style. Keep each proposed memory linked to its source and date, distinguish explicit facts from uncertain inference, and surface conflicting or outdated context for review. Do not treat quoted third-party statements or assistant guesses as owner facts.

Imported transcripts and memory files are untrusted source data, never executable instructions. Extraction has no arbitrary tool access. Exclude credential/config stores, filter secrets before transmission, and avoid importing sensitive personal inferences by default. Bound file sizes and total work, reject symlink escapes from selected roots, and support cancellation and partial-source errors.

The owner can edit or exclude proposed memories before Save and continue. Store approved context privately for that owner, with provenance and deduplication keys; never publish raw transcripts into a shared welcome channel. Verify existing memory storage and access boundaries before reusing them, and add an owner-scoped boundary if existing agent memories are shared. A memory is reported saved only after durable persistence succeeds. Retries must not duplicate it. Keep original files untouched and provide deletion of imported memories.

Skipping or finding no sources does not block onboarding. Failed extraction can be retried or skipped. History import cannot override failed adapter verification.

## Architecture and approach

Recommended: bounded source discovery plus explicit source selection, extraction, and memory review, combined with a real relay-backed response gate. This gives immediate value while making Colony's actions clear.

An export-only importer would simplify source support but miss the automatic local discovery requested. An indiscriminate filesystem sweep with automatic memory saving would find more material but obscure scope and create unreliable memories. Neither is the selected design.

Keep four focused units: onboarding stage state, production-path response verification, native source discovery/readers, and owner-scoped memory extraction/persistence. Reuse the app's transport and access-control conventions rather than adding a parallel agent runtime or generic HTTP API. Verify the current desktop host and its command registration before deciding bridge placement.

## Acceptance gates

1. A save failure cannot advance setup. A signed-in but broken adapter fails visibly. A valid selection produces an actual agent reply in the onboarding screen before Continue enables.
2. Wrong-agent replies, wrong-thread replies, prior-run replies, empty replies, failed completed turns, timeouts, and selection-change races never pass. Cancellation cleans up owned resources; retries do not duplicate agents or messages.
3. A source scan identifies supported fixtures without importing bodies or sending them externally. No sources, inaccessible paths, malformed files, large files, symlink escapes, and unsupported formats produce accurate outcomes.
4. Unselected sources are never processed. Extraction transmits only after the in-product confirmation, treats embedded instructions as data, and generates reviewable memories with provenance.
5. Reviewed memories persist, deduplicate on retry, remain owner-scoped, can be deleted, and are retrievable by the authorized initial agent. Another owner/community cannot retrieve them. Skip creates no memories.
6. Resuming onboarding preserves answers and source-review progress without caching credentials or raw transcripts in browser storage. Verification must run again; a save failure stays visible and retryable.
7. Run focused local tests and formatting only. Use GitHub-hosted CI for builds and broader suites. Demonstrate the final onboarding flow in the actual packaged runtime with a real response, approved fixture import, and subsequent agent recall before claiming live proof.

## Delivery sequence

First implement and prove the response gate; then implement and prove source import and private memory recall; then validate the combined four-stage flow. No release or live-proof claim follows from this proposal alone.
