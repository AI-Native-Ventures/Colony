# Approved Blocks Redesign Implementation Plan

> Agentic execution uses the active collaboration team and root integration. The user has approved the visual specification; proceed within the existing production goal. Tests below run in GitHub CI unless they are quick targeted checks against already-installed dependencies.

**Goal:** Carry the accepted Blocks gallery into actual Colony channels and threads, with working agent contracts and bounded media viewing.

**Architecture:** Keep the closed native grammar and shared theme system. Add optional presentation/data bindings where the accepted templates require them; version manifests without invalidating old pinned messages. Reuse native viewers, with a shared media collection and a lazy bounded Mermaid-to-declarative-SVG path.

**Tech stack:** React19, TypeScript, Tailwind semantic/rem tokens, Rust block validators/CLI, Mermaid11.17.2 (stable, repository dependency-policy compliant), existing PDF.js/SheetJS viewers, GitHub Actions/Playwright.

## Task 1 — Agent contract (Volta)

Files: crates/buzz-cli/src/{lib.rs,commands/blocks.rs}; crates/buzz-core/src/block.rs and schema fixtures; core question/details/interview JSON; desktop/src/features/blocks/{contracts.ts,blockValidation.ts}; ui/primitives/{types.ts,resolvers.ts,BlockQuestion.tsx}; ui/BlockRenderContext.tsx; ACP base and onboarding prompts.

- [x] Add `buzz blocks describe --handle` resolving the active manifest and reporting schema/examples/actions/customizable paths in one response.
- [ ] Add optional closed presentation fields agreed in the spec, Question.mode_path, Details.items_path and table column formats. Reject unsupported tokens and malformed paths consistently in Rust and TypeScript.
- [ ] Make new Question data-driven. Validate selected IDs, uniqueness and single/multi bounds against the exact pinned instance on the relay. Keep old pinned schemas and hashes accepted.
- [ ] Make Details list data-driven and wire Interview unknown input from the fact field only for the trusted core contract. Correct plain-file/processor invocation documentation.
- [x] Author focused schema and action regressions; check success/failure fixtures in GitHub CI.

## Task 2 — Native presentation (Mill)

Files: desktop/src/features/blocks/ui/primitives/Block{Card,CardList,Chart,Details,Layout,Metric,Section,Status,Actions,Table}.tsx and focused primitive rendering tests.

- [x] Apply approved spacing, hierarchy, colors, overflow and empty-state behavior using semantic theme and named text tokens.
- [x] Implement closed presentation variants without inspecting business block handles.
- [x] Preserve real controls, keyboard focus, live action state and reduced-motion preferences.
- [ ] Check small/large/empty tables, Boolean/number formatting, long Details, layouts and all chart kinds through existing primitive rendering tests on GitHub.

## Task 3 — Media collections (Fermat)

Files: ui/primitives/BlockMedia.tsx; shared/ui/media-preview/*; shared/ui/file-preview/{InlineFilePreview,PdfFilePreview,SpreadsheetFilePreview}.tsx; shared markdown grouping where compatible; focused media tests.

- [x] Preserve occurrence-based ordering and invalid entries. Keep image-only groups as carousels; build a filename/poster selector for video/document/mixed groups.
- [x] Mount one expensive active viewer; preserve per-file lightweight page/sheet/row/zoom/playback state and pause/release replaced playback.
- [x] Add image thumbnails without breaking duplicate URLs, aspect ratio, download identity, swipe or keyboard navigation.
- [x] Author tests for mixed/duplicate/invalid files and selection state, with no document editing or annotation expansion.

## Task 4 — Diagrams (root)

Files: desktop/src/shared/ui/diagram-preview/{diagramModel.ts,diagramRuntime.ts,DiagramPreview.tsx,DiagramFilePreview.tsx}; shared/ui/markdown/{CodeBlock.tsx,FileCard.tsx}; desktop/package.json; pnpm-lock.yaml; focused diagram tests and public/rich-previews diagram sources.

- [x] Accept bounded Mermaid flow/sequence/relationship source and .mmd/.mermaid attachments using existing native file reads. Preserve unavailable/invalid source and original downloads.
- [x] Lazy-load pinned Mermaid; use strict fixed configuration, source/edge bounds, cancellation checks, serialized per-theme rendering, and output as a declarative SVG image.
- [x] Flatten library CSS to allowed presentation attributes and discard active/external output; keep current native SVG contract unchanged.
- [x] Add Fit/zoom/expand/download with both themes and no source editing.
- [ ] Test source rejection, static SVG conversion and representative diagram output in GitHub-hosted browser execution.

## Task 5 — Composites and catalogue (root)

Files: core composite JSON, core trusted digest registrations, BlocksSettingsCard.tsx, BlocksCatalogList.tsx, BlockCatalogCard.tsx, BlockRenderer.tsx, RichPreviewGallery.tsx, catalogue model helpers/tests.

- [x] Translate Blueprint, Brief, Interview, Receipt and remaining composite trees into the approved generic presentation grammar; preserve schemas/actions and version history.
- [x] Replace the long catalogue wall with searchable categorized preview tiles and one selected full example. Preserve workshop/work-in-chat handoff, publisher trust, permissions and unavailable states.
- [x] Include actual built-in examples and shared viewer variants; never replace live content with hardcoded demo data in message rendering.

## Task 6 — Acceptance and delivery (root)

Files: desktop/tests/e2e/blocks-*.spec.ts and helpers, playwright.config.ts where registration is required, existing CI artifact configuration, acceptance evidence document.

- [x] Build a deterministic GitHub-hosted gallery test from every bundled core manifest, plus live channel/thread fixture instances, both themes and narrow/wide widths. Wait for animations before distinct screenshots.
- [ ] Exercise dynamic choice submission, Interview unknown response, table search, carousel, multi-file switching and Mermaid expansion in the hosted tests.
- [ ] Perform focused source/format checks, sign off commits, push develop PR without heavy local hooks, arm auto-merge and inspect every applicable CI result and visual artifact.
- [ ] Fix found failures and rerun affected checks. Coordinate release owner before a single protected production promotion, then verify published artifacts/updater/runtime separately.

## Implementation gate, 2026-09-10

All implementation slices and the 62-case browser acceptance suite are written. Focused tests, final all-24 manifest validation/trust checks, exact-file formatting and frozen dependency-policy verification pass. No full local suite, Rust compilation or app build ran. GitHub compilation/browser execution, source-matched screenshot inspection, protected production promotion, packaging/publication and authenticated runtime proof remain open.

Review corrections include closed CardList layout fields, explicit card children for canonical serialization, CSS-ready diagram theming, focus restoration, static sequence-symbol handling and source resource guards. Repeated/ambiguous Question targets now fail validation; external Question responses fail closed without verified data. The new Rust serialization regression checks actual typed manifest bytes against the reviewed raw assets.

## Rollout compatibility gate — desktop 0.16.13 and relay 0.11.10

The released 0.16.12 client rejects the fifteen revised manifests because its closed schema does not recognize the new fields and its Core digest registry predates them. It preserves the original plain-text message with a warning, but cannot offer the new Block actions. Its bundled agent CLI also rejects those active manifests. Historical messages pinned to the earlier definitions remain supported. This requires an ordered normal app update, not a new protocol migration.

The existing update flow installs signature-verified bytes into the outer Colony bundle, then relaunches. Electron window cleanup asks the native host to exit; native shutdown stops its tracked local agent process groups and sweeps owned orphans. On the next launch, packaged helper lookup and the worker PATH prioritize the new bundle's native binaries. After the workspace identity and relay are restored, eligible local agents with `start_on_app_launch` resume; agents without that setting remain stopped. Restore starts the managed listeners with fresh packaged helpers; it does not promise continuation of an interrupted model turn. Source: `use-updater.ts`, `src-electron/{shell-commands,main,native-host,runtime-paths}.mjs`, and `src-tauri/src/{electron_host/updater.rs,shutdown.rs,commands/workspace.rs,managed_agents/restore.rs,managed_agents/discovery/command_paths.rs,managed_agents/runtime/path.rs}`. This is source verification, not proof that the owner's installation has updated.

- [ ] Finish protected promotion and verify the public 0.16.13 Mac/Windows assets and both signed updater entries. Keep relay 0.11.10 deployment manual until this publication gate passes.
- [ ] Before activating relay 0.11.10, verify the owner's actual installed Colony app has completed its normal update/relaunch and reports 0.16.13. Record the installed bundle/version and running native helper paths; confirm old owned helper processes are gone and the required managed agents are running from the updated bundle. Respect saved auto-start choices; start an otherwise stopped agent through the existing app flow only when needed for the authorized proof. Do not substitute a private candidate or a downloaded installer for this installed-runtime gate.
- [ ] Deploy the exact promoted relay 0.11.10 image through the hosted Fly workflow, then verify live readiness/version and the seeded catalogue heads. Desktop publication alone does not activate the server definitions or action validation.
- [ ] Prove discovery, new Block posting, and Question/Interview actions in the owner's authenticated channel/thread with the updated packaged helpers. Keep this separate from mocked browser screenshots and isolated hosted native fixtures.

Other installations that remain on 0.16.12 retain readable text fallback, but need the normal desktop update/relaunch to view or act on the revised Blocks and to refresh their bundled agents. Do not describe those old installations as compatible with the new interactive catalogue.

## First hosted evidence and correction pass

CI run `34477025102` at `32855e89ef5032cca65b419d3a164cbe48522e97` passed all 48 core/theme channel-and-thread cases with 96 distinct captures, all collection examples and the existing rich document/media scenarios. Source-matched visual inspection identified the company-plan row override, outer composition frames and spreadsheet row-heading width, now corrected for a fresh capture pass. The same run passed Rust lint, desktop lint/typecheck, relay/backend integration, and the isolated real-relay Blocks action/receipt/restart gate. Hosted native first-job workflow `34477025151` also passed. These prove the stated test environments, not the production runtime.

Remaining first-run failures were an outdated ACP prompt assertion, bounded-media test expectations, duplicated image selectors, seeded channel membership, virtualized-history assumptions, old Question roles/submission semantics, small-table controls, and the Mermaid flow/ER conversion. Corrective tests retain trust, signed completion and fallback assertions. The diagram failure was reproduced in a three-example standalone headless probe using the pinned package; its generated unused shadow filters are now narrowly removed, all three diagrams render, and a focused regression fails on the old code and passes on the fix. Arbitrary, referenced or modified filters and HTML remain rejected. No local app build or full CI ran.

The corrected commit still requires a fresh full GitHub run, its new diagram/channel/thread captures, and protected promotion before publication and live verification.
