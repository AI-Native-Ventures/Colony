# Colony rich previews — first release

**Status:** Revised product scope following the user's simplification on 2026-09-09. This replaces the earlier editing-heavy proposal for the first release. Implementation is in draft PR #671; local targeted checks have passed. Full GitHub CI, production merge and live proof remain pending.

## Product contract

People can see, browse, play, expand and download work directly inside Colony channels and threads. Visual presentation, theme consistency and reliable previews are the priority. People download the original file when they want to edit it elsewhere. Ordinary conversation remains available to discuss the work or ask the agent for another output.

Native editing, targeted selections, highlights, annotations, revision comparison and native maps are outside this release. The earlier selection-and-editing interaction study illustrates deferred exploration, not the current acceptance target.

## Viewing experiences

| Content | First-release experience |
| --- | --- |
| Excel workbook | Read-only tabular preview with sheet navigation and readable column headings and values. Expand to inspect more data; download the original workbook. No formula editing or calculation engine. If a calculated value is unavailable, make that explicit. |
| CSV | Read-only table with sensible column widths and row navigation for long files; download the original. No mapping or data-cleaning workflow. |
| PDF | Legible page preview with page navigation, expand/zoom and original download. No annotation, highlighting, form filling or page editing. |
| Other documents | Show a readable rendition when supported, otherwise an informative file attachment with an original download. Preserve the distinction between a preview rendition and the original file. |
| One image | A full-width media surface within the reading pane, preserving the image's aspect ratio and complete content. Expand for a larger view; download the original. |
| Two or more related images | One carousel with previous/next controls, touch swiping and a position indicator such as 2 / 5. Each image gets a generous viewing area. Preserve the supplied order. |
| SVG and vector artwork | Use the image/carousel presentation. Render supported vector content clearly and preserve the original download. Unsupported vector formats may use a supplied rendered preview; do not imply every vector format is natively renderable. |
| Slides and social carousels | Browse the ordered slides using the same carousel. Show accompanying text when present. Download original/source files or the available exports, labelled accurately. No reordering or slide editing. |
| Video | Useful poster image, visible play control and duration when known, playback, seeking, volume, expanded viewing and original download. No trimming, scene editing or new annotation workflow. |
| Audio | A compact player with play/pause, seeking, elapsed/total time and original download. A waveform is optional and must come from actual audio if shown. No transcript editor or audio-editing tools. |
| Diagrams and charts | Display a readable rendered diagram or supported chart, with expansion and download where available. Static SVG/image output is sufficient. No node editing, workflow execution or simulation engine. |
| Unsupported content | Clear filename, file type and size when known, concise preview-unavailable state and a working original download. |

## Media presentation rules

- One image uses the available message-content width. It does not stretch across the channel and thread panes or distort the image.
- Two or more images belonging to one output use a single carousel, not a vertical stack of large attachments. Separate outputs in different messages stay separate.
- The carousel preserves order, gives a clear item count, and keeps a stable stage when navigating mixed image proportions. Fit complete images rather than cropping away text or artwork.
- Portrait content can use a bounded inline height and expand for detailed viewing. Wide images remain legible; small source files must not be deceptively sharpened or reconstructed.
- File titles, page/sheet/item counts and downloads use a consistent location. Content occupies most of the surface; metadata stays compact.
- Expanded views return to their original message and preserve the current page, sheet, image index or playback position.
- Large documents and collections load progressively. A partial data preview identifies its limits rather than presenting a subset as the whole file.
- Previews and original downloads refer to the same file version and retain its access boundary.

## Video poster behaviour

The intended result is an informative still before playback, including for videos that begin with a black frame or fade from black.

Prefer a valid, nonblank supplied poster when available. Otherwise, generate a poster from an early frame with visible content. Analyse a bounded set of frames first; use near-black detection rather than requiring exactly zero-valued black pixels. An implementation can step beyond an opening black segment and sample slightly farther into a fade.

Generate and cache the poster once per video version where the media is accessible for processing. Do not decode or scan every video each time a message is rendered. Processing runs independently of playback. The poster's timestamp must not change the video's playback start time.

If the opening is long, the whole video is dark, the file is inaccessible for extraction or extraction fails, show a designed video placeholder with filename, play and download controls. Playback remains available where supported. Do not promise that a nonblack frame always exists, and do not fabricate one.

Browser video supports a separate poster image. FFmpeg exposes near-black frame/segment detection, making automated poster selection feasible. Choosing the exact processing path still requires implementation and verification against Colony's supported runtimes.

Sources: [MDN video poster](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video#poster); [FFmpeg blackdetect](https://ffmpeg.org/ffmpeg-filters.html#blackdetect).

Source check at `origin/develop` commit `5cfa527139`: `desktop/src-tauri/src/commands/media_transcode.rs` already extracts a poster at one second, without a black-pixel/content check; extraction/upload failures are best-effort. `desktop/src/features/blocks/ui/primitives/BlockMedia.tsx` passes no poster, while Markdown videos do pass image/thumb metadata. `VideoReviewPosterPreview` also treats decoded-frame availability as sufficient to hide its poster. Reuse and connect the existing poster path before adding another extraction mechanism. These are source findings, not a reproduction of the reported black preview or proof of Electron/package parity.

## Theme and motion

The container, controls, file labels, table surfaces, loading placeholders and carousel indicators use Colony's current theme and accent. Documents and artwork retain their authored colours. Semantic error states remain recognisable in every theme.

Use short press feedback, smooth carousel transitions, restrained preview arrival and expansion. Preserve space while media loads so the conversation does not jump. Loaded history stays still; reduced-motion settings remove spatial transitions. Audio and video sound do not autoplay.

## Inline model and reasoning controls

The earlier request for model and reasoning controls remains separate from file editing. Keep compact controls near the composer, with supported choices and an explicit next-reply scope. A thread preference may be an explicit option. Implementing these controls must not silently change teammate-wide defaults or media-generation engines.

Model comparison, restarting active runs with a new model and advanced tuning can follow later. They are not dependencies for rich previews.

## Blocks page

Keep the existing Blocks entry and replace weak sample treatments with real, read-only renderer examples. The gallery should demonstrate one image, a two-image carousel, a longer carousel, a table, a PDF, SVG, audio and video in the current Colony shell.

The same components render in the catalog, channels and threads. Verify light/dark/accent themes, narrow panes, mixed aspect ratios, long names, slow loading and failed previews. No editor controls or nonworking sample actions should appear.

## First proof gate

Render representative files through the real message/Block paths and prove:

1. Excel/CSV/PDF information is readable and originals download correctly.
2. Single and multiple-image layouts follow the rules above, including mixed proportions and SVG.
3. Videos that open black get useful posters when extractable and still play from the beginning; ordinary, all-dark, unavailable and failed-extraction cases remain usable.
4. Audio and expanded viewing work without losing the originating conversation.
5. Themes, reduced motion and narrow channel/thread widths preserve clarity and layout stability.

The gate is viewing, playback, presentation and downloads. No editing, highlighting or native map capability is required to pass it.
