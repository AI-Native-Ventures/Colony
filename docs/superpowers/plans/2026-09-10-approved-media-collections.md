# Approved Media Collections Implementation Plan

**Goal:** Match the approved viewing gallery with ordered, theme-aware media collections, one active heavy viewer, original downloads, and retained per-file positions.

**Architecture:** `BlockMedia` resolves data and passes ordered valid/error entries to a shared `MediaCollection`. Images retain their existing full-width/expanded viewer and gain thumbnail navigation. Other collections mount only the selected player/document; lightweight document/playback positions remain owned by the mounted collection. Ordinary Markdown grouping reuses this collection only for identifiable attachment runs, preserving prose and spoiler boundaries.

**Tech stack:** Existing React, TypeScript, Tailwind semantic tokens, PDF/spreadsheet viewers, native media downloads, Node test fixtures. No dependencies, builds, version changes, Git mutations, or reference-gallery edits.

## Task map

- [x] Add `mediaCollectionModel.ts` for stable occurrence keys and ordered metadata, plus focused pure tests.
- [x] Add `MediaCollection.tsx` and its active-viewer boundary: selector with filename/type/poster, invalid entry notices, single active viewer, per-file document state, media cleanup and original downloads. Add focused component regressions.
- [x] Add optional `initialViewState` / `onViewStateChange` to `InlineFilePreview`, preserving current defaults. Delegate only this boundary/helper/test to the existing file-preview agent.
- [x] Replace `BlockMedia` stacking with the shared collection; coordinate visible overflow entries with the resolver owner. Keep invalid entries in their original positions.
- [x] Add accessible, lazy thumbnail selectors to `ImagePreview`, retain original ratios for a single image, and preserve existing spoiler/gallery/context-menu behavior. Extend the focused regression.
- [x] Reuse the collection in ordinary Markdown for bounded attachment-only runs, including mixed image/video/file runs where metadata is available. Preserve prose order and separate spoiler scopes; document remaining unsupported grouping cases.
- [x] Inspect source and run only focused checks if existing dependencies are available. Updated the existing image browser assertions to scope the original stage. Root owns the new whole-catalogue browser spec and broader GitHub gates for active-only media, document/seek retention, original downloads, and narrow light/dark layout.

## Acceptance gate

Images remain full width with ordered thumbnails. Videos, PDFs, workbooks and mixed attachments have a readable ordered selector and one selected viewer. Changing selection pauses/releases the previous media, retains the file's page/sheet/row/zoom or playback position, and downloads the correct original. Invalid entries and items beyond the Block preview cap are visible rather than silently lost. Both themes and narrow threads use the existing semantic tokens. No execution, annotation or editing is added.

## Current proof and limits

- 36 focused tests passed across collection identity, actual selection/cleanup state with lightweight renderer mocks, file navigation hook, image interaction/rendering and Markdown rendering. Heavy file parsing/playback and browser pixels remain GitHub proof.
- Exact-file Biome check and repository file-size ratchet passed. No local build, full suite, Git mutation, install, or reference-gallery edit.
- Ordinary collections group adjacent direct attachments within one paragraph. Prose, spoilers and paragraph boundaries remain separate; there is no global message/channel playback coordinator.
- Inactive file viewers are unmounted and parsing/PDF workers abort. The existing native fetch IPC cannot cancel a request already issued, so a prior bounded native transfer can finish after selection changes.
- Image selectors use supplied thumbnails or already-loaded originals. Unseen originals without thumbnail metadata show a numbered placeholder until viewed, avoiding speculative downloads.
- DOCX/PPT and other unsupported formats keep existing file/workspace/download actions. Root's Mermaid file viewer flows through the generic FileCard fallback.

## GitHub visual acceptance follow-up

Root delegated the acceptance spec after the media implementation snapshot. `approved-blocks-design.spec.ts` and its fixture helper discover the relay's exact 24 core assets, validate the source contracts and example data, and render signed instances through real MessageRow/channel and right-thread surfaces under mock native/relay transport. Both themes receive per-manifest screenshots and source/hash inventory. Separate cases cover catalogue filters/search, per-file document positions and original bytes, video teardown, mixed order/unavailable files, complex flow/sequence/ER diagrams in gallery and ordinary fenced conversations, Mermaid file source identity, and malformed SVG fallback.

The spec is registered in the existing smoke project. Existing workflow path filters already select desktop and core-manifest changes. All screenshot calls use the mandatory animation helper and testInfo output paths. No browser or build has run locally. Static syntax, exact-file formatting and size checks pass. Contract preflight caught unknown `mode` fields in company-brief/company-blueprint; the contract owner corrected them. A fresh bounded preflight now validates all 24 exact source manifests and their first-example data with zero failures.

## Owned file inventory

- [desktop/src/features/blocks/ui/primitives/BlockMedia.tsx](/private/tmp/colony-blocks-approved-20260910/desktop/src/features/blocks/ui/primitives/BlockMedia.tsx)
- [desktop/src/shared/ui/media-preview/MediaCollection.tsx](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/media-preview/MediaCollection.tsx)
- [desktop/src/shared/ui/media-preview/MediaCollectionViewer.tsx](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/media-preview/MediaCollectionViewer.tsx)
- [desktop/src/shared/ui/media-preview/MediaCollection.test.mjs](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/media-preview/MediaCollection.test.mjs)
- [desktop/src/shared/ui/media-preview/mediaCollectionModel.ts](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/media-preview/mediaCollectionModel.ts)
- [desktop/src/shared/ui/media-preview/mediaCollectionModel.test.mjs](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/media-preview/mediaCollectionModel.test.mjs)
- [desktop/src/shared/ui/media-preview/ImagePreview.tsx](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/media-preview/ImagePreview.tsx)
- [desktop/src/shared/ui/media-preview/ImagePreview.test.mjs](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/media-preview/ImagePreview.test.mjs)
- [desktop/src/shared/ui/media-preview/mediaPreviewRendering.test.mjs](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/media-preview/mediaPreviewRendering.test.mjs)
- [desktop/src/shared/ui/file-preview/InlineFilePreview.tsx](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/file-preview/InlineFilePreview.tsx)
- [desktop/src/shared/ui/file-preview/useFilePreviewViewState.ts](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/file-preview/useFilePreviewViewState.ts)
- [desktop/src/shared/ui/file-preview/useFilePreviewViewState.test.mjs](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/file-preview/useFilePreviewViewState.test.mjs)
- [desktop/src/shared/ui/markdown/MediaPreview.tsx](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/markdown/MediaPreview.tsx)
- [desktop/src/shared/ui/markdown/MediaPreview.test.mjs](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/markdown/MediaPreview.test.mjs)
- [desktop/src/shared/ui/markdown/mediaCollectionChildren.tsx](/private/tmp/colony-blocks-approved-20260910/desktop/src/shared/ui/markdown/mediaCollectionChildren.tsx)
- [desktop/tests/e2e/approved-blocks-design.spec.ts](/private/tmp/colony-blocks-approved-20260910/desktop/tests/e2e/approved-blocks-design.spec.ts)
- [desktop/tests/e2e/approved-blocks-design.fixtures.ts](/private/tmp/colony-blocks-approved-20260910/desktop/tests/e2e/approved-blocks-design.fixtures.ts)
- [desktop/tests/e2e/rich-media-previews.spec.ts](/private/tmp/colony-blocks-approved-20260910/desktop/tests/e2e/rich-media-previews.spec.ts)
- [desktop/tests/e2e/rich-document-previews.spec.ts](/private/tmp/colony-blocks-approved-20260910/desktop/tests/e2e/rich-document-previews.spec.ts)
- [desktop/tests/e2e/image-attachment-gallery.spec.ts](/private/tmp/colony-blocks-approved-20260910/desktop/tests/e2e/image-attachment-gallery.spec.ts)
- [desktop/playwright.config.ts](/private/tmp/colony-blocks-approved-20260910/desktop/playwright.config.ts)
- [docs/superpowers/plans/2026-09-10-approved-media-collections.md](/private/tmp/colony-blocks-approved-20260910/docs/superpowers/plans/2026-09-10-approved-media-collections.md)
