# Rich inline previews

The same read-only viewers render in channel messages, thread replies and the Blocks catalog. The catalog examples are shipped files under `desktop/public/rich-previews/`; they need no agent run or remote account. The application shell and theme remain the existing workspace design.

## User experience

- A single image uses the available message width. Consecutive images share an ordered carousel with arrows, a count, expansion and original download. SVGs render as images, without inserting their markup into the page.
- Excel and CSV show saved values in a paginated table. Excel exposes sheet tabs. Cached formula results are displayed; formulas are never executed. PDF shows one page at a time, page navigation and zoom. Expansion keeps the current sheet/page.
- Video keeps a poster visible until playback. New native uploads sample a bounded sequence of frames and reject near-black candidates. A useful poster is best effort; the original video always starts at zero. Older uploads keep their existing poster until regenerated.
- Audio supports play/pause, seeking and original download. No waveform or transcript is invented.
- Diagrams can be delivered as SVG, and the existing chart Block displays values alongside its graph.
- Previews load near the viewport. Failed, oversized or unsupported files retain an understandable message and original-download action.

There is no spreadsheet/PDF/image editor, annotation tool or native map in this release. Existing conversation actions and video review features are preserved.

## Agent output

Use normal attachments with accurate `imeta` MIME, original filename and dimensions when available. The Blocks `media` primitive also accepts a URL string, ordered URL array, a descriptor, or an array of descriptors resolved by its existing `url_path` field. Descriptor fields are `url`, optional `alt`, `filename`, `mime`, `poster`, `width`, `height`, `size`, and `durationSeconds`. Sources and posters must be HTTP(S) URLs. Keep mixed output in its intended reading order; adjacent images form one carousel.

The bundled `@media` 1.1.0 accepts either `url` plus optional metadata, or `items` with up to 24 URL strings/descriptors. It requires a top-level `alt`. Its manifest version and trust digest advance together; previous pinned manifests remain trusted and renderable.

```json
{
  "alt": "Launch campaign",
  "items": [
    { "url": "https://your-relay/media/slide-1.svg", "alt": "Opening slide", "filename": "slide-1.svg", "width": 1080, "height": 1080 },
    { "url": "https://your-relay/media/slide-2.svg", "alt": "The outcome", "filename": "slide-2.svg", "width": 900, "height": 1200 }
  ]
}
```

File access and downloads use the existing native validation path; preview rendering does not grant access to additional files, origins or communities. Bundled catalog fixtures are a separate, exact local asset namespace.

## Validation

Quick targeted Node tests cover source validation, compatible media data, actual CSV/Excel parsing, resource limits, original downloads, carousel behavior and scoped model requests. GitHub CI owns full TypeScript, lint, native/Rust, build and browser checks. Do not run heavy local CI or application builds for this goal.

Browser specs cover catalog viewers, channel/thread attachment rendering, theme changes, navigation, original downloads and failure states. CI artifacts are the visual proof; mocked browser proof is distinct from packaged desktop or live relay proof. The production merge and any automatic deployments are recorded separately in the goal's final report.
