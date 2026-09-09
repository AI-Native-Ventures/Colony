# Rich Inline Previews Implementation Plan

> Execution: bounded collaboration agents implement the media, document and model-control plans in this shared worktree; the primary agent owns integration, review, GitHub CI and production promotion. The user has authorised the complete phase sequence. No further routine execution approval is needed.

**Goal:** Make work readable, browsable, playable and downloadable in Colony channels and threads, with consistent themed Blocks previews and explicit next-reply model/effort controls.

**Architecture:** Reuse specialised shared viewers in Markdown attachments, native Blocks and the catalog. Preserve source-file URLs and existing conversation boundaries. Extend media data resolution compatibly; keep model choices on the signed message/run rather than mutating the agent's defaults.

**Tech stack:** React 19, native theme/Tailwind tokens, existing Embla carousel and PDF.js, Rust media processing and ACP runtime, Electron's native-host bridge, node:test, Playwright, GitHub Actions.

## Constraints and gates

- The approved design is `docs/superpowers/specs/2026-09-09-rich-inline-previews-design.md`.
- **User override:** no `just ci`, full local test suites, local application builds or cold Rust compilation. Use small targeted JS tests and changed-file formatting locally. Full lint/typecheck/build/Rust/browser checks run in GitHub CI. Apply this to automatic hooks too; bypass only the heavy local hook invocation when pushing, retaining sign-off and required remote gates.
- No native file editing, selection/highlighting, annotations, native maps, model comparisons or active-run restarts.
- Keep the accepted develop workspace shell, reading typography and channel/right-thread structure.
- No direct pushes to main. Development PR targets develop with auto-merge armed; production promotion waits until every non-skipped check passes.

## Acceptance matrix

| ID | Real behaviour | Implementation owner | Evidence |
| --- | --- | --- | --- |
| V1 | One image fills the reading surface without cropping; two/many ordered images share one carousel | Media | Component tests and channel/thread screenshots |
| V2 | SVG and slide images stay clear; expansion and original downloads work | Media | Mixed-aspect and SVG fixtures through Markdown/Block rendering |
| V3 | Excel sheets and CSV rows display actual file data without editing | Documents | File parser tests, real XLSX/CSV fixtures, browser screenshots |
| V4 | PDF pages render, paginate/expand and download | Documents | Real PDF fixture in message and Blocks preview |
| V5 | Video poster skips a black opening when possible, remains visible before playback, video still starts from zero | Media | Native extraction tests in CI and player/browser fault cases |
| V6 | Audio plays/seeks and downloads through shared presentation | Media | Actual media fixture, player tests and browser evidence |
| V7 | Broken, unsupported and large file previews remain understandable and downloadable | Documents/media | Bounded-input tests, broken URL and unavailable poster cases |
| V8 | Catalog uses the same viewers and responds to light/dark/accent/narrow layouts | Primary | Catalog interaction tests and distinct screenshots |
| V9 | Static diagrams and existing charts remain readable and expandable where supported | Primary/media | SVG/chart catalog and thread examples |
| M1 | Model and supported reasoning choices are discoverable near the composer | Model agent | Capability/loading/error and composer browser coverage |
| M2 | Choice affects only the intended teammate's next request and preserves saved defaults | Model agent | Signed request, batching and runtime application tests in GitHub CI |
| R1 | Develop integration and production promotion pass the required remote matrix | Primary | PR/check/merge SHA records |

## Task 1 — shared media and poster pipeline

Owned plan: `2026-09-09-rich-preview-media.md`.

Files include `desktop/src/shared/ui/media-preview/`, Markdown image/audio rendering, `VideoPlayer.tsx`, `VideoReviewPosterPreview.tsx`, and native `commands/media_transcode.rs`.

- [ ] Add reusable exports used by both Markdown and Blocks:

```ts
type MediaPreviewImage = {
  src: string; alt: string; filename?: string; downloadUrl?: string;
  width?: number; height?: number;
};
// ImagePreview: ordered items, optional title/className/initialIndex.
// AudioPlayer: src, optional filename/downloadUrl/durationSeconds/className.
```

- [ ] Prove black-frame and rendering regressions in focused tests; implement bounded poster extraction and retained-poster behaviour. Preserve existing timecoded video review.
- [ ] Route one/multiple Markdown images into the shared image surface; keep groups limited to one message/output.
- [ ] Add real media fixtures and GitHub Playwright coverage without building locally.

## Task 2 — shared read-only file previews

Owned plan: `2026-09-09-rich-preview-documents.md`.

Files include `desktop/src/shared/ui/file-preview/`, Markdown `FileCard.tsx`, existing PDF workspace primitives where reusable, and original-download helpers.

- [ ] Choose a maintained, bounded XLSX reader after checking its official documentation; primary agent owns dependency/lockfile changes.
- [ ] Parse CSV/XLSX values from actual bytes, disclose truncation or unavailable formula results and preserve sheet/page location during expansion.
- [ ] Reuse PDF.js with cleanup/cancellation, without form/annotation/editing features.
- [ ] Keep URL and byte loading on the existing authorised access path; do not introduce arbitrary native file/network access.
- [ ] Add real file fixtures, failure cases, quick parser tests and CI browser coverage.

## Task 3 — compatible Blocks integration

Primary-owned files:

- `desktop/src/features/blocks/ui/primitives/types.ts`
- `desktop/src/features/blocks/ui/primitives/resolvers.ts`
- `desktop/src/features/blocks/ui/primitives/BlockMedia.tsx`
- `desktop/src/features/blocks/ui/BlockRenderer.tsx`
- `desktop/src/features/blocks/ui/primitives/primitives.test.mjs`
- Core media/gallery manifests and their tests when a public composition needs updating.

- [ ] Preserve string and URL-array inputs. Add validated descriptor object/array inputs through existing `url_path`, with these fields:

```ts
type PreviewDescriptor = {
  url: string; alt?: string; mime?: string; filename?: string;
  poster?: string; width?: number; height?: number;
};
```

- [ ] Accept only safe HTTP(S) URLs from untrusted Block data; independently validate poster URLs and integrity fields. Do not execute SVG/HTML markup.
- [ ] Group adjacent image descriptors into `ImagePreview`, route audio to `AudioPlayer`, pass poster into `VideoPlayer`, and route documents to the shared file viewer. Preserve mixed-media order.
- [ ] Remove the blanket 32rem cap for content-heavy Blocks while retaining the reading pane's width and quiet metadata.
- [ ] Add regression tests with concrete cases:

```js
assert.equal(inferMediaKind({url:'https://example.test/logo.svg',alt:'Logo'}), 'image');
assert.equal(inferMediaKind({url:'https://example.test/voice.mp3',alt:'Voice'}), 'audio');
const result = resolveMedia({type:'media',url_path:'/items',alt:'Campaign'}, {
  items: [{url:'https://example.test/clip.mp4',poster:'javascript:alert(1)',mime:'video/mp4'}],
});
assert.equal(result[0].item.poster, undefined);
```

## Task 4 — Blocks gallery and visual consistency

Primary-owned files: `BlockCatalogCard.tsx`, `BlocksCatalogList.tsx`, `BlocksSettingsCard.tsx`, a small `RichPreviewGallery.tsx` plus sample metadata/assets, and the catalog tests.

- [ ] Put working read-only previews before explanatory metadata, with a concise selected experience and sample label.
- [ ] Render actual shared components against bundled sample files for image/carousel/SVG, CSV/XLSX/PDF, audio/video and diagram/chart examples. No fake external URLs or imitation viewer screenshots.
- [ ] Use native renderers for existing Block examples; disable consequential catalog actions rather than publishing demo events.
- [ ] Use semantic theme tokens for all surrounding surfaces, controls and statuses. Preserve authored asset colours. Use container-appropriate layout, rem text tokens and reduced-motion rules.
- [ ] Capture distinct channel, thread and catalog states under GitHub browser CI. Check light/dark/accent, narrow panes, failed preview and mixed image dimensions.

## Task 5 — scoped inline model and reasoning

Owned plan: `2026-09-09-inline-model-reasoning.md`.

- [ ] Use runtime-catalog-derived capabilities and model/effort choices in two compact composer controls.
- [ ] Add a versioned, validated signed message tag identifying the exact target teammate and requested supported model/effort.
- [ ] Keep overridden requests isolated from unrelated queue batches and restore normal default resolution after the request. Preserve conversation context and existing agent identity.
- [ ] Surface request/application errors honestly; do not treat a control timeout or fallback model as success.
- [ ] Update agent configuration contributor rules for the new request scope, and add runtime/relay/composer tests. Keep providers/credentials and media engines outside this override.

## Task 6 — integration, GitHub CI and production

- [ ] Run only the relevant small test files, for example:

```sh
cd desktop
node --import ./test-loader.mjs --experimental-strip-types --experimental-test-module-mocks --test src/features/blocks/ui/primitives/primitives.test.mjs src/features/blocks/ui/BlockCatalogCard.test.mjs
```

- [ ] Format/check changed files only, inspect the complete diff, and obtain independent bounded reviews. Do not increase source-size limits.
- [ ] Commit scoped changes with `git commit -s`, push the feature branch, open a develop PR with the acceptance matrix and honest local-versus-CI evidence, and arm auto-merge.
- [ ] Inspect GitHub failures, repair causes, and rerun affected remote checks. Retrieve browser screenshots/reports produced in CI for visual inspection. A green code check alone does not prove the approved viewing experience.
- [ ] Wait for the develop merge/queue gate. Inspect the exact production promotion diff and release conventions, then open or update the develop-to-main promotion PR.
- [ ] Require all non-skipped promotion checks to pass before merging. Do not disable rules or bypass a red gate.
- [ ] Verify main contains the feature, inspect the resulting deployment/package workflow state, and report merge, deployment, published package and real runtime evidence separately. Mark the goal complete only once the requested production merge and required evidence are obtained.

## Integration checkpoint — first GitHub run

- Worktree: `/private/tmp/colony-rich-inline-20260909`, branch `codex/rich-inline-previews`, base `5cfa527139`.
- Commit `bf03c3e9ce` pushed; draft PR https://github.com/AI-Native-Ventures/Colony/pull/671 starts full remote CI.
- Shared viewers, real gallery files, theme integration, media1.1 manifest/trust update and scoped model runtime are implemented. Source verification found SVG/audio uploads were still blocked by the old media pipeline. Follow-up work adds strict shared validators and canonical audio sanitation; no blanket MIME denial removal.
- Targeted Node regression checks and changed-file formatting passed. No heavy local tests, builds or Cargo compilation have run.
- Remote browser/native proof, develop integration, production promotion and publication remain pending.

## GitHub findings — first remote matrix

- Develop advanced to `a414fa900c` (stable Electron ad-hoc release); merged into this branch as `9c86cfce86`. Desktop feature version advances to `0.16.10`; relay version is `0.11.9`.
- CI run `34383742160` reached green Rust Lint, Web and Security. Linux desktop jobs stopped in dependency installation because the runner Chrome APT repository served a package index with a mismatched hash. No integrity checks were weakened.
- Electron run `34383742113` caught a missing `relayOrigin` binding in Markdown; repairing the implementation before the next remote matrix. Browser and packaged feature proof have not yet run successfully.

## GitHub findings — complete media and recovery snapshot

- Snapshot `70ffb7a1b3` includes strict SVG uploads, canonical audio, correct single-image sizing, bounded catalogs, safe reply-selection recovery, native-picker file previews and empty/sparse workbook/PDF cleanup fixes.
- CI run `34385407594`: Rust Lint, Unit Tests, both server cross-compiles, Web and Security passed. Some desktop jobs reached frontend tests; others again failed on the exact Google Chrome repository hash mismatch. Browser and packaged acceptance remain pending.
- A shared preflight now isolates only the unrelated Chrome APT source on ephemeral GitHub-hosted Ubuntu runners. It preserves Ubuntu/security sources and all package integrity/update/install failures. Ten fast fixture tests pass, including observed failure before wrapper integration; no local APT command or build was executed. The required changed-paths job runs this contract and selects affected desktop checks when these helpers change.

## GitHub findings — rendered media and packaged build

- Snapshot `70ffb7a1b3` also passed the full frontend unit suite/build, smoke shard 2 (99 tests), and narrow-thread carousel/theme browser assertions. CI screenshots were inspected for the actual theme, image expansion and visible video poster. Full document/model browser proof is still pending.
- Media traces showed the Python fixture server ignored browser byte ranges. Fixtures now return exact-byte 206 responses and tests require seekability; the three-second audio assertion is unchanged. A separate product fix retains video review position until metadata arrives, with stronger real-playback retention assertions.
- Image dimensions again reach the image element before decoding, retaining full-width proportional layout. Explicit document download and video filename assertions now target the actual accessible controls.
- The ad-hoc Mac application build completed; packaged startup, signup and bundled-agent discovery checks passed before a Rust audio test assertion failed to compile. The assertion is corrected. This does not establish the complete package gate.
- Legacy migration failed before Electron launch. The fixture now lets WebKit's batched writer settle before opening an independent reader, preserving exact persistent reads, graceful exit and unchanged-source hashes. This timing hypothesis still requires hosted validation.
- The combined targeted follow-up suite passed 18 tests in about one second. No local application build, full CI or Cargo test was run. Integration and production promotion remain pending.

## GitHub findings — complete hosted candidate at `69c1a91c3a`

- CI `34389938272` passed Rust lint/unit tests, both server builds, mobile, full Desktop Core, Tauri flags, all relay and browser integration suites, and smoke shards 1–3. Native desktop reported 3,004 passing tests; real MP3/WAV/M4A/Ogg FFmpeg conversion ran with mandatory proof enabled. Mesh `34389938074` passed.
- Electron candidate `34389938212` passed both jobs. The actual ad-hoc stable package passed relocated startup, hosted-signup targeting, bundled agent discovery, import/restart/recovery and 23 worker isolation tests. The separate migration fixture preserved six source values and two businesses with no reseeding, preserved subsequent Electron edits, and matching legacy/final source hashes. This is hosted synthetic proof, not a real owner's installed upgrade or publication.
- All four new rich-media cases passed on their first attempts, including exact audio seek, video-position retention, theme changes and narrow-thread order. Workbook/CSV/PDF fixtures passed original SHA-256 download checks, sheet/page/zoom retention and narrow-layout checks. Their actual CI screenshots were inspected.
- Model controls rendered correctly in both channel/thread captures and sent the exact requested signed tags. The reset test incorrectly expected a control to remain after the final mention was cleared; its replacement checks absence, then a fresh mention returning to defaults.
- Smoke shards 4–6 still require a new pass: replace obsolete masonry/image-button assertions with the approved carousel geometry while retaining thumbnail, image-click, context-menu and spoiler behavior; correct the video's decoded-frame mock; center a tall document's Reply control before its normal click; wait for the intended narrow single-thread layout.
- Blocks Live Gate produced an explicit failed owner receipt after agent-proposal execution. Investigation compares its signed evidence and broker/native fixture with the executed green baseline `2131f5d6`, run `34364648424`; the gate remains required and unchanged.
- Current edits remain bounded follow-up corrections. No heavy local CI/builds have run, and neither develop integration nor production promotion has occurred.
