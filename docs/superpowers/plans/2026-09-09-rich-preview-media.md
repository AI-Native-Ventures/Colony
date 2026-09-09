# Rich Preview Media Implementation Plan

> **For agentic workers:** Execute the bounded media subsystem in the shared worktree. The root agent coordinates commits, dependencies and GitHub CI. User authorization overrides local full-build requirements: do not run Cargo builds/tests, full suites or local E2E builds.

**Goal:** Make images, image collections, SVG, audio and video readable and playable within channels and threads, with original downloads and theme-aware controls.

**Architecture:** Add shared React viewers that both Markdown and Blocks consume. Preserve the existing validated media download path and video review state. Improve poster selection once in native upload processing, keeping playback independent of poster sampling.

**Tech Stack:** React, native CSS theme tokens, existing Radix Dialog, native HTML media, Rust FFmpeg upload processing shared by Tauri and Electron, focused Node tests.

## Owned files and interfaces

- `desktop/src/shared/ui/media-preview/ImagePreview.tsx`: image/ordered carousel, arrows/swipe/count, fit-complete-image layout and expanded view.
- `desktop/src/shared/ui/media-preview/AudioPlayer.tsx`: basic playback/seeking/timing with download and error state.
- `desktop/src/shared/ui/media-preview/MediaDownloadButton.tsx`: native validated download action, shared by viewers.
- `desktop/src/shared/ui/media-preview/mediaPreviewModel.ts`: pure media classification/navigation/state helpers and focused tests.
- `desktop/src/shared/ui/media-preview/index.ts`: public `ImagePreview`, `MediaPreviewImage`, `AudioPlayer` exports.
- `desktop/src/shared/ui/markdown.tsx`: replace related image mosaic presentation; route audio attachments to the shared player.
- `desktop/src/shared/ui/VideoPlayer.tsx` and `VideoReviewPosterPreview.tsx`: optional poster validation/load state and designed fallback; preserve playback/review behaviour.
- `desktop/src-tauri/src/commands/media_transcode.rs` and an extracted helper if needed: bounded near-black-aware poster candidates using local transcoded bytes.
- Relevant existing Electron upload code: use equivalent bounded poster strategy; no new renderer URL fetch authority.

`MediaPreviewImage` holds `src`, `alt`, optional `filename`, `downloadUrl`, `width`, and `height`. `ImagePreview` receives ordered `items`, optional `title`, `className`, and `initialIndex`. `AudioPlayer` receives `src`, optional `filename`, `downloadUrl`, `durationSeconds`, and `className`.

## Steps and acceptance

- [x] Add focused regression assertions: audio classification failed before implementation, then passed. Added actual Markdown routing/rendering tests and a native poster fixture test for CI.
- [x] Implement shared media controls with semantic theme tokens, rem text, keyboard accessible labels, reduced motion and original-download URLs.
- [x] Implement one full-width image or one stable-stage carousel; preserve order and expanded index, fit complete portrait/landscape/SVG content, avoid offscreen original loading.
- [x] Wire Markdown image groups and audio links, preserving hidden-spoiler behaviour and existing media URL access rules.
- [x] Keep valid posters before playback; surface designed fallback for missing/failed posters, carry explicit poster metadata through available public interfaces, and preserve play-from-zero independently of thumbnail timestamps.
- [x] Improve native upload extraction with a bounded scan, near-black filtering, timeouts/cancellation and no fabricated all-dark image. Apply equivalent behaviour in the actual Electron upload path.
- [x] Run only targeted Node tests and scoped formatting/type validation where available. Add CI-run visual coverage if practical; do not build locally.
- [x] Report exact files, focused checks, new limitations and CI-required proof to root; do not commit or push.

## Proof boundaries

The implementation gate is viewing/playback/expansion/downloads. No image editing, annotations, highlights, maps, or arbitrary generated JavaScript. User art retains its own colours; viewer controls follow the selected theme. Packaging, native media decoding and rendered browser proof remain separate GitHub CI/packaged gates.

## Implementation evidence

- Focused Node run: 49 tests passed across media models/renderers, actual Markdown routing, audio classification, and relay URL routing. The original audio regression was observed failing before the implementation.
- Scoped Biome check passed for 19 media-owned files; single-file rustfmt check passed. Markdown is 1912 lines (below baseline1924), VideoPlayer 2187 (below baseline2211) after coherent extraction.
- Locally generated6-second video fixture has a2-second black leader. Direct FFmpeg pixel probe: at1s,0/2304 visible pixels; at2s,2304/2304. This proves the old fixed1s strategy's fixture failure, not execution of the new Rust code.
- Native Rust fixture test requires FFmpeg when COLONY_REQUIRE_POSTER_PROOF=1 in the required Desktop Core CI job; no Rust tests/builds run locally. Electron invokes the same Rust upload command, so no duplicate implementation was added.
- Playwright spec `rich-media-previews.spec.ts` covers light/dark gallery, real SVG/audio/video, ordered keyboard/swipe navigation, expansion/focus return, original SVG download and narrow native thread. Added expectation update to existing video spec for full-width portrait containers. Browser execution is reserved for GitHub CI.
- No shared/global media state caches, no new arbitrary script rendering, no commits/pushes from this worker.
