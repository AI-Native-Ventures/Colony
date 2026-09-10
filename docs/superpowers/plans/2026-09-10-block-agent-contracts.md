# Block agent contracts implementation plan

> Approved gallery implementation slice. Root coordinates the shared worktree, review and commits. This task does not run builds, full suites, hooks or Git mutations.

**Goal:** Let agents discover and populate useful native Blocks, preserve older pinned cards, and make Interview's existing unknown-answer action usable.

**Architecture:** Keep immutable definitions and the closed native grammar. Add optional data-backed Question mode and Details items sources while leaving legacy node fields valid. Publish new core definition versions with retained old trust digests and deterministic seed timestamps immediately after their old seed (later human catalog selections remain dominant). Existing action, publisher and catalog authority stays intact.

**Tech stack:** Rust CLI/core/relay, React/TypeScript validators and native primitives, focused existing Node contract tests; Rust proof runs in GitHub CI.

## Task map

- [x] Discovery: add `BlocksCmd::Describe { handle, manifest }`; resolve the active catalog or explicit pinned manifest and output definition, schema, examples, actions, editable schema fields, processor/attention requirements, and a correct command template. Implement output assembly in a focused CLI helper module with Rust tests; no new HTTP API.
- [x] Question: optional `mode_path`, existing fixed `mode` fallback, data-backed prompt/choices in core Question 2.0.0. A resolved single-select question has maximum one selection; verify mode and selected IDs/count against the pinned instance at relay action validation. Keep old static Question definitions parseable/trusted. Cover missing/invalid mode, dynamic single/multiple choices and legacy fixture behavior.
- [x] Details: optional `items_path` with bounded strict label/value pairs and existing static `items` as legacy fallback. Core Details 1.1.0 accepts 1–24 populated pairs or the original label/value payload. Validate dynamic items consistently and preserve literal values as text.
- [x] Interview: derive only the declared `interview.unknown` input from its validated fact field, making the current button directly usable; preserve declaration validation and processor routing. No unrequested automatic chat-answer extraction.
- [x] Agent instructions: teach `describe`, configurable Question/Details, plain input file paths, processor identity, existing-thread routing, and separate action receipts. Correct onboarding examples without pretending chat replies are structured receipts.
- [x] Compatibility/proof: retain old core digests, add focused old/new vectors and regression tests, run only quick existing JS tests if dependencies are available. Author focused Rust/relay tests for CI, explicitly report them as not locally run.

Root owns `BlockPrimitive.tsx` and visual styling outside `BlockQuestion.tsx`; existing Details/Question props can remain node/data pass-through. No publisher trust, catalog authority or action signer bypass is introduced.

## Handoff proof

- Implemented read-only `buzz blocks describe` with resolved schema/definition/examples/actions/customizable fields, pinning instructions and existing authority limits. Blocks CLI enum and fallback interpolation were extracted into focused modules; one-pass fallback expansion keeps supplied text literal and clears absent optional fields.
- New Question 2.0.0 and Details 1.1.0 functional manifests retain their exact previous JSON in `core_blocks/legacy`. Root owns coordinated trusted digests/publication mappings and composite visual migration.
- Added shared typed optional native presentation fields; no arbitrary CSS, HTML, script, tree mutation or publisher/catalog permission changes. Dynamic answers are checked at relay ingest against the pinned Question's actual IDs and mode. External data-backed Question answers fail closed when the relay cannot verify choices from inline instance data.
- Interview unknown controls send their actual fact. CLI receipts only claim attention resolution for an instance that requested it; normal conversational answers are not fabricated as signed actions.
- Focused JS proof: 45/45 authoring, dynamic fields, Question, native primitives, presentation and bundled composite vectors passed in 2.34 seconds. New real prompt/items payloads are explicitly rejected by the original pinned demo contracts and accepted by current definitions. File-size ratchet passed.
- Direct rustfmt completed; Rust tests (including exact bundled Question, CLI describe, fallback and non-attention receipt vectors) are authored for CI, not compiled or run locally. Existing cached Biome 2.4.7 rejected the repo's nested config, so owned frontend files were formatted through isolated stdin with the repository's formatter settings; canonical CI lint remains a separate gate.

## Owned files

- `crates/buzz-cli/src/lib.rs`
- `crates/buzz-cli/src/block_cli.rs` (new)
- `crates/buzz-cli/src/commands/blocks.rs`
- `crates/buzz-cli/src/commands/blocks_description.rs` (new)
- `crates/buzz-cli/src/commands/blocks_fallback.rs` (new)
- `crates/buzz-core/src/block.rs`
- `crates/buzz-core/src/block_instance_fields.rs` (new)
- `crates/buzz-core/src/block_presentation.rs` (new)
- `crates/buzz-sdk/src/blocks.rs` (test constructors for additive optional fields)
- `crates/buzz-relay/src/blocks.rs` (pinned Question action validation)
- `crates/buzz-relay/src/core_blocks/primitives/question.json`
- `crates/buzz-relay/src/core_blocks/primitives/details.json`
- `crates/buzz-relay/src/core_blocks/legacy/question-1.0.0.json` (new exact previous definition)
- `crates/buzz-relay/src/core_blocks/legacy/details-1.0.0.json` (new exact previous definition)
- `crates/buzz-acp/src/base_prompt.md`
- `crates/buzz-acp/src/company_onboarding_prompt.md`
- `desktop/src/features/blocks/contracts.ts`
- `desktop/src/features/blocks/blockValidation.ts`
- `desktop/src/features/blocks/questionOptions.ts`
- `desktop/src/features/blocks/dynamicBlockFields.ts` (new)
- `desktop/src/features/blocks/dynamicBlockFields.test.mjs` (new)
- `desktop/src/features/blocks/interviewAction.ts` (new)
- `desktop/src/features/blocks/blockAuthoring.test.mjs` (new)
- `desktop/src/features/blocks/ui/BlockRenderContext.tsx`
- `desktop/src/features/blocks/ui/primitives/types.ts`
- `desktop/src/features/blocks/ui/primitives/resolvers.ts`
- `desktop/src/features/blocks/ui/primitives/BlockQuestion.tsx`
- `desktop/src/features/blocks/ui/primitives/primitives.test.mjs`
