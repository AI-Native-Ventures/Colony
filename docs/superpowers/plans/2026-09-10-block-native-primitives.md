# Approved Blocks native primitives implementation plan

**Goal:** Carry the approved gallery's readable, roomy presentation into shared native primitives without changing action authority or inventing business-specific renderers.

**Architecture:** Existing validated trees still feed the same primitive components. Shared, scoped CSS uses native theme tokens and rem dimensions; container queries respond to the actual block width. Optional generic presentation fields are coordinated with the contract owner before use.

**Reference:** Read-only `colony-blocks-site/dist` approved by the user; `/private/tmp/colony-block-design-inventory.md` records the 24 core blocks and their states.

## Task map

- [x] Card, Section, Metric, Details: restrained surfaces, clear hierarchy, complete wrapped content, omission of empty detail values.
- [x] Layout and CardList: container-scoped grids; full-width carousel cards in narrow threads, in-flow keyboard-accessible navigation.
- [x] Table: quiet small datasets, opt-in filtering/sorting for longer data, complete wrapping, numeric alignment, explicit boolean values, stable selection identity.
- [x] Chart: readable legend/data fallback, native token colors, bounded geometry including one-value donuts and signed values.
- [x] Status and Actions: restrained semantic state styling and readable wrapping, preserving current signed availability/submitting/completion behavior.
- [x] Focused tests: data visibility, empty omission, table control policy and formatting, chart edge geometry, action authority and container layout markup. Run only scoped tests if dependencies are already available; otherwise hand authored tests to hosted CI.
- [x] Report generic grammar/composite migration requirements for Blueprint, Brief, Interview, Receipt and any remaining parity gaps to root.

## Boundaries and proof

No dependency installs, app builds, full suites, hooks, Git mutations, version changes, release actions, or Sites changes. Other owners retain contracts/resolvers, questions/context, media, renderer, composite manifests, examples gallery and diagram ownership. Parent subsequently assigned the workspace catalogue UI to this slice. Local source/test proof is separate from hosted browser screenshots and approved-design parity.

## Added catalogue slice

- [x] Replace mounting every full preview with metadata-only tiles and one selected native renderer.
- [x] Add search and origin/primitive-identity categories; preserve catalog ordering, installed/custom entries, publisher concerns and capability labels.
- [x] Preserve Workshop and Work in chat handoffs. Display supplied manifest/preview data without per-handle fixture substitutions.
- [x] Put Workspace and Examples in separate lazy tab panels so the two libraries do not mount their viewers concurrently.
- [x] Add interactive selection/filter/refresh tests and a regression against media/artifact fixture substitution.

## Narrow proof and remaining parity

Ten new primitive presentation tests passed. Six catalogue tests passed, including the actual React selection/filter/handoff flow and exactly one mounted preview. Biome passed for owned files. The initial broader primitive test file had two stale Question expectations after the parallel owner changed its native inputs/submission wording; these were reported to the Question owner through root. No browser build, full suite or screenshot proof was run locally.

Root owns all composite tree migrations and hosted browser proof. Generic fields cover lead/callout hierarchy, populated details/disclosures, numbered lists, rows/rails, comparisons and real step progress. Fine reference details such as Blueprint avatar badges/inline inclusion markers and chart units/axes/center totals require compatible generic data/presentation support if they are mandatory; this slice does not infer business data or add per-handle rendering.

## Approved catalogue sample adaptation

The existing signed example schemas require absolute HTTP URLs. Parent authorized a narrower catalogue-only adapter instead of changing signed example data or relaxing those schemas: `ReadonlyBlockPreview` uses the ordinary primitive renderer, overriding only media collections with an exact known placeholder URL when both catalogue origin and verified manifest trust are `core`. The seven existing media placeholders use three bundled SVGs, with an explicit “Sample files shown” label. Preview and download point to the same sample, and original placeholder metadata is discarded for that different file. Unknown URLs, unavailable entries, custom/installed blocks, and ordinary non-media content stay unchanged. Direct conversation rendering does not use this adapter.

All eleven focused catalogue tests passed, including five new boundary/wiring tests. They verify nested collection scope/order, original-data immutability, unknown URL/metadata preservation, trust gating, integrity rejection, and sample preview/download identity. The native media collection is mocked in the new wiring tests; actual viewer and download behavior remains a hosted browser proof obligation. An initial test fixture path was corrected after its explicit missing-file failure. No builds or full suites were run.
