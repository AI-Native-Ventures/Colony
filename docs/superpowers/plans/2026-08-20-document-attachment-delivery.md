# Document Attachment Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Markdown and PDF files uploadable through the Buzz CLI, openable from message attachment cards, and readable inside the channel workspace.

**Architecture:** Keep the existing authenticated generic `/upload` relay path and NIP-92 attachment model. Extend the CLI policy and metadata formatter, classify workspace files from trusted MIME plus a narrow filename allowlist, and render PDFs with `pdfjs-dist` canvases without relaxing the Tauri CSP.

**Tech Stack:** Rust, clap CLI, Nostr NIP-92 tags, React 19, TypeScript, pdfjs-dist, Node test runner, Playwright, Tauri

---

## File map

- Modify `crates/buzz-cli/src/client.rs`: generic upload limits, filename metadata, and unit tests.
- Modify `crates/buzz-cli/src/commands/messages.rs`: media-aware attachment Markdown and unit tests.
- Modify `desktop/package.json` and `desktop/pnpm-lock.yaml`: add the PDF.js runtime.
- Modify `desktop/src/features/workspace/lib/workspaceFileContent.ts`: classify text, PDF, and binary presentations.
- Modify `desktop/src/features/workspace/lib/workspaceFileContent.test.mjs`: prove MIME and extension classification.
- Modify `desktop/src/features/workspace/lib/openAttachmentInWorkspace.ts`: require a safe relay-backed HTTP(S) URL.
- Modify `desktop/src/features/workspace/lib/openAttachmentInWorkspace.test.mjs`: reject sender-local paths at the delivery boundary.
- Create `desktop/src/features/workspace/kinds/PdfWorkspaceViewer.tsx`: render PDF pages to canvases with retryable errors.
- Create `desktop/src/features/workspace/kinds/PdfWorkspaceViewer.test.mjs`: prove viewer state helpers.
- Modify `desktop/src/features/workspace/kinds/fileKind.tsx`: route loaded files to text, PDF, or binary views and expose retry.
- Modify `desktop/src/testing/e2eBridge.ts`: provide deterministic attachment bytes in browser tests.
- Modify `desktop/tests/e2e/file-attachment.spec.ts`: prove Markdown and PDF attachment opening.

### Task 1: Permit safe generic CLI uploads

**Files:**
- Modify: `crates/buzz-cli/src/client.rs`
- Test: `crates/buzz-cli/src/client.rs`

- [ ] **Step 1: Add failing policy tests**

Add these tests beside the existing upload policy tests:

```rust
#[test]
fn generic_documents_use_the_generic_limit() {
    assert_eq!(upload_size_limit("application/pdf"), MAX_FILE_BYTES);
    assert_eq!(
        upload_size_limit("application/octet-stream"),
        MAX_FILE_BYTES
    );
}

#[test]
fn images_and_video_keep_their_existing_limits() {
    assert_eq!(upload_size_limit("image/png"), MAX_IMAGE_BYTES);
    assert_eq!(upload_size_limit("video/mp4"), MAX_VIDEO_BYTES);
}

#[test]
fn dangerous_active_content_is_rejected() {
    assert!(!is_upload_mime_allowed("text/html"));
    assert!(!is_upload_mime_allowed("image/svg+xml"));
    assert!(is_upload_mime_allowed("application/pdf"));
    assert!(is_upload_mime_allowed("application/octet-stream"));
}
```

- [ ] **Step 2: Run the full CLI package tests and confirm the new test fails**

Run: `cargo test -p buzz-cli`

Expected: FAIL because `upload_size_limit`, `MAX_FILE_BYTES`, and `is_upload_mime_allowed` do not exist.

- [ ] **Step 3: Replace the fixed allowlist with the relay-compatible policy**

In `crates/buzz-cli/src/client.rs`, replace `ALLOWED_MIMES` and the current size selection with:

```rust
const BLOCKED_UPLOAD_MIMES: &[&str] = &[
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
];

const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 500 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

fn is_upload_mime_allowed(mime: &str) -> bool {
    !BLOCKED_UPLOAD_MIMES.contains(&mime)
}

fn upload_size_limit(mime: &str) -> u64 {
    if mime.starts_with("video/") {
        MAX_VIDEO_BYTES
    } else if mime.starts_with("image/") {
        MAX_IMAGE_BYTES
    } else {
        MAX_FILE_BYTES
    }
}
```

Use the helpers in `upload_file`:

```rust
if !is_upload_mime_allowed(&mime) {
    return Err(CliError::Usage(format!("unsupported file type: {mime}")));
}

let max = upload_size_limit(&mime);
if bytes.len() as u64 > max {
    return Err(CliError::Usage(format!(
        "file too large: {} bytes (max {})",
        bytes.len(),
        max
    )));
}
```

Review commit `b327854a6` for intent before implementing. Port only the upload-policy portion so the filename and message-format work remains explicit in this branch.

- [ ] **Step 4: Run the full CLI package tests**

Run: `cargo test -p buzz-cli`

Expected: PASS.

- [ ] **Step 5: Commit the upload policy**

```bash
git add crates/buzz-cli/src/client.rs
git commit -m "feat(cli): allow generic file uploads" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 2: Preserve filenames and emit correct attachment Markdown

**Files:**
- Modify: `crates/buzz-cli/src/client.rs`
- Modify: `crates/buzz-cli/src/commands/messages.rs`
- Test: `crates/buzz-cli/src/client.rs`
- Test: `crates/buzz-cli/src/commands/messages.rs`

- [ ] **Step 1: Add failing descriptor and formatter tests**

Add a descriptor fixture and assertions in the existing test modules:

```rust
fn generic_descriptor() -> BlobDescriptor {
    BlobDescriptor {
        url: "https://relay.example/media/report.pdf".into(),
        sha256: "a".repeat(64),
        size: 42,
        mime_type: "application/pdf".into(),
        uploaded: 1,
        dim: None,
        blurhash: None,
        thumb: None,
        duration: None,
        filename: Some("Q3 [final].pdf".into()),
    }
}

#[test]
fn imeta_includes_the_preserved_filename() {
    assert!(build_imeta_tag(&generic_descriptor())
        .contains(&"filename Q3 [final].pdf".to_string()));
}

#[test]
fn generic_attachment_is_a_named_link() {
    assert_eq!(
        format_attachment_markdown(&generic_descriptor()),
        "[Q3 \\[final\\].pdf](https://relay.example/media/report.pdf)"
    );
}

#[test]
fn image_and_video_keep_media_markdown() {
    let mut image = generic_descriptor();
    image.mime_type = "image/png".into();
    image.filename = Some("chart.png".into());
    assert_eq!(
        format_attachment_markdown(&image),
        "![image](https://relay.example/media/report.pdf)"
    );

    image.mime_type = "video/mp4".into();
    assert_eq!(
        format_attachment_markdown(&image),
        "![video](https://relay.example/media/report.pdf)"
    );
}
```

- [ ] **Step 2: Run the full CLI package tests and confirm failure**

Run: `cargo test -p buzz-cli`

Expected: FAIL because `filename` and `format_attachment_markdown` are missing.

- [ ] **Step 3: Extend the descriptor and imeta builder**

Add the field to `BlobDescriptor` and append it in `build_imeta_tag`:

```rust
/// Original sanitized filename supplied by the uploader (optional).
#[serde(skip_serializing_if = "Option::is_none")]
pub filename: Option<String>,
```

```rust
if let Some(ref filename) = d.filename {
    tag.push(format!("filename {filename}"));
}
```

After each successful primary or legacy upload response, set the returned descriptor filename from the local path:

```rust
fn attachment_filename(file_path: &str) -> String {
    std::path::Path::new(file_path)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("attachment")
        .chars()
        .filter(|character| !character.is_control())
        .take(255)
        .collect()
}
```

```rust
let filename = attachment_filename(file_path);
let mut descriptor = response_descriptor;
descriptor.filename = Some(filename);
Ok(descriptor)
```

Apply that finalization to both `/upload` and legacy `/media/upload` results.
Update every `BlobDescriptor` literal reported by `rg -n "BlobDescriptor \\{" crates/buzz-cli` with `filename: None` unless that fixture is explicitly proving a preserved name.

- [ ] **Step 4: Add the media-aware formatter and use it in message sending**

Add to `crates/buzz-cli/src/commands/messages.rs`:

```rust
fn escape_markdown_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

fn format_attachment_markdown(desc: &crate::client::BlobDescriptor) -> String {
    if desc.mime_type.starts_with("video/") {
        return format!("![video]({})", desc.url);
    }
    if desc.mime_type.starts_with("image/") {
        return format!("![image]({})", desc.url);
    }
    let filename = desc.filename.as_deref().unwrap_or("attachment");
    format!("[{}]({})", escape_markdown_label(filename), desc.url)
}
```

Replace the send loop body construction with:

```rust
for file_path in &p.files {
    let desc = client
        .upload_file(file_path)
        .await
        .map_err(|error| CliError::Other(format!("upload failed for {file_path}: {error}")))?;
    media_content.push('\n');
    media_content.push_str(&format_attachment_markdown(&desc));
    media_tags.push(crate::client::build_imeta_tag(&desc));
}
```

- [ ] **Step 5: Run the full CLI package tests**

Run: `cargo test -p buzz-cli`

Expected: PASS, including filename and Markdown formatting tests.

- [ ] **Step 6: Commit filename-preserving messages**

```bash
git add crates/buzz-cli/src/client.rs crates/buzz-cli/src/commands/messages.rs
git commit -m "feat(cli): preserve generic attachment names" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 3: Classify workspace documents safely

**Files:**
- Modify: `desktop/src/features/workspace/lib/workspaceFileContent.ts`
- Modify: `desktop/src/features/workspace/lib/workspaceFileContent.test.mjs`
- Modify: `desktop/src/features/workspace/lib/openAttachmentInWorkspace.ts`
- Modify: `desktop/src/features/workspace/lib/openAttachmentInWorkspace.test.mjs`

- [ ] **Step 1: Add failing presentation and delivery-boundary tests**

Add the classification case to `workspaceFileContent.test.mjs`:

```js
test("classifies trusted text, extension-backed text, PDF, and binary files", () => {
  assert.equal(resolveWorkspaceFilePresentation("notes.md", "application/octet-stream"), "text");
  assert.equal(resolveWorkspaceFilePresentation("data.json", "application/json"), "text");
  assert.equal(resolveWorkspaceFilePresentation("paper.pdf", "application/pdf"), "pdf");
  assert.equal(resolveWorkspaceFilePresentation("paper.PDF", "application/octet-stream"), "pdf");
  assert.equal(resolveWorkspaceFilePresentation("payload.exe", "application/octet-stream"), "binary");
  assert.equal(resolveWorkspaceFilePresentation("page.html", "text/html"), "binary");
});
```

Add the path-only case to `openAttachmentInWorkspace.test.mjs`, using its existing dependency fixture:

```js
test("attachment delivery rejects a sender-local path", () => {
  const result = openAttachmentInWorkspace({
    channelId: "alpha",
    attachment: {
      filename: "plan.md",
      mime: "text/markdown",
      url: "/Users/sender/plan.md",
    },
  }, dependencies);
  assert.deepEqual(result, {
    ok: false,
    message: "This attachment does not have a safe relay URL.",
  });
});
```

Update loaded-file assertions to expect `presentation` instead of `isText`.

- [ ] **Step 2: Run the full desktop unit suite and confirm failure**

Run: `cd desktop && pnpm test`

Expected: FAIL because `resolveWorkspaceFilePresentation` and `presentation` do not exist.

- [ ] **Step 3: Replace the boolean with a three-way presentation**

In `workspaceFileContent.ts`, define and use:

```ts
export type WorkspaceFilePresentation = "text" | "pdf" | "binary";

export type LoadedWorkspaceFile = {
  name: string;
  mime: string;
  presentation: WorkspaceFilePresentation;
  bytesBase64: string;
};

const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".log",
  ".markdown",
  ".md",
  ".txt",
]);

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

export function resolveWorkspaceFilePresentation(
  name: string,
  mime: string,
): WorkspaceFilePresentation {
  const normalizedMime = mime.toLowerCase();
  const extension = extensionOf(name);
  if (normalizedMime === "application/pdf" || extension === ".pdf") return "pdf";
  if (normalizedMime === "text/html" || normalizedMime === "application/xhtml+xml") {
    return "binary";
  }
  if (
    normalizedMime.startsWith("text/") ||
    normalizedMime === "application/json" ||
    TEXT_EXTENSIONS.has(extension)
  ) {
    return "text";
  }
  return "binary";
}
```

Map both local and URL sources through `resolveWorkspaceFilePresentation(file.name, file.mime)` so relay-provided `application/octet-stream` Markdown renders as text.

- [ ] **Step 4: Require a safe URL for a delivered attachment**

Import `parseWorkspaceUrl` into `openAttachmentInWorkspace.ts` and validate before opening the tab:

```ts
const safeUrl = parseWorkspaceUrl(attachment.url);
if (!safeUrl) {
  return {
    ok: false,
    message: "This attachment does not have a safe relay URL.",
  };
}
```

Store `safeUrl.href` in the tab payload. Keep `FileSource` path support for an explicit same-machine file picker, which is a separate convenience and never delivery evidence.

- [ ] **Step 5: Run the full desktop unit suite**

Run: `cd desktop && pnpm test`

Expected: PASS.

- [ ] **Step 6: Commit document classification**

```bash
git add desktop/src/features/workspace/lib/workspaceFileContent.ts desktop/src/features/workspace/lib/workspaceFileContent.test.mjs desktop/src/features/workspace/lib/openAttachmentInWorkspace.ts desktop/src/features/workspace/lib/openAttachmentInWorkspace.test.mjs
git commit -m "feat(desktop): classify workspace documents" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 4: Render PDFs inside the File workspace tab

**Files:**
- Modify: `desktop/package.json`
- Modify: `desktop/pnpm-lock.yaml`
- Create: `desktop/src/features/workspace/kinds/PdfWorkspaceViewer.tsx`
- Create: `desktop/src/features/workspace/kinds/PdfWorkspaceViewer.test.mjs`
- Modify: `desktop/src/features/workspace/kinds/fileKind.tsx`

- [ ] **Step 1: Add PDF.js**

Run: `cd desktop && pnpm add pdfjs-dist`

Expected: `pdfjs-dist` appears in `package.json` dependencies and the lockfile changes.

- [ ] **Step 2: Add failing viewer helper tests**

Create `PdfWorkspaceViewer.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { clampPdfScale, decodePdfBytes } from "./PdfWorkspaceViewer.tsx";

test("PDF scale stays inside the supported range", () => {
  assert.equal(clampPdfScale(0.2), 0.5);
  assert.equal(clampPdfScale(1.25), 1.25);
  assert.equal(clampPdfScale(4), 2.5);
});

test("base64 PDF bytes decode without a data URL", () => {
  const bytes = decodePdfBytes(globalThis.btoa("%PDF-1.4"));
  assert.equal(new TextDecoder().decode(bytes), "%PDF-1.4");
});
```

- [ ] **Step 3: Run the full desktop unit suite and confirm failure**

Run: `cd desktop && pnpm test`

Expected: FAIL because `PdfWorkspaceViewer.tsx` does not exist.

- [ ] **Step 4: Create the canvas viewer**

Create `PdfWorkspaceViewer.tsx` with exported helpers, `pdfjs-dist/build/pdf.mjs`, and `pdfjs-dist/build/pdf.worker.min.mjs?url`. The component must load `Uint8Array` bytes, render every page into its own canvas, cancel outstanding render tasks on unmount or zoom, expose 50% to 250% zoom controls, show `workspace-pdf-loading`, show `workspace-pdf-error`, and call the supplied `onRetry` from a visible Retry button. Use this interface:

```tsx
export type PdfWorkspaceViewerProps = {
  bytesBase64: string;
  name: string;
  onRetry: () => void;
};

export function clampPdfScale(value: number): number {
  return Math.min(2.5, Math.max(0.5, value));
}

export function decodePdfBytes(bytesBase64: string): Uint8Array {
  const binary = globalThis.atob(bytesBase64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
```

Set the worker once at module scope:

```ts
import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
```

Do not change `desktop/src-tauri/tauri.conf.json`. Canvas rendering is compatible with the existing `object-src 'none'` policy.

- [ ] **Step 5: Route FileBody to the PDF viewer and make loading retryable**

In `fileKind.tsx`, add a `reloadToken` state and include it in the load effect dependency. Render by `file.presentation`:

```tsx
const [reloadToken, setReloadToken] = React.useState(0);
const retry = React.useCallback(() => setReloadToken((value) => value + 1), []);
```

```tsx
if (file.presentation === "pdf") {
  return (
    <PdfWorkspaceViewer
      bytesBase64={file.bytesBase64}
      name={file.name}
      onRetry={retry}
    />
  );
}

if (file.presentation === "binary") {
  return (
    <div className="p-4 text-sm text-muted-foreground" data-testid="workspace-file-binary">
      {file.name} cannot be previewed ({file.mime})
    </div>
  );
}
```

Replace the file-load error with:

```tsx
<div className="space-y-3 p-4 text-sm" data-testid="workspace-file-error">
  <p className="text-destructive">{error}</p>
  <button className="rounded-md border border-border px-3 py-2" onClick={retry} type="button">
    Retry
  </button>
</div>
```

- [ ] **Step 6: Run the desktop package checks**

Run: `cd desktop && pnpm test && pnpm typecheck && pnpm check`

Expected: all commands PASS.

- [ ] **Step 7: Commit the PDF viewer**

```bash
git add desktop/package.json desktop/pnpm-lock.yaml desktop/src/features/workspace/kinds/PdfWorkspaceViewer.tsx desktop/src/features/workspace/kinds/PdfWorkspaceViewer.test.mjs desktop/src/features/workspace/kinds/fileKind.tsx
git commit -m "feat(desktop): render PDFs in workspace" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 5: Prove Markdown and PDF message delivery in the browser

**Files:**
- Modify: `desktop/src/testing/e2eBridge.ts`
- Modify: `desktop/tests/e2e/file-attachment.spec.ts`

- [ ] **Step 1: Add failing attachment-open Playwright cases**

Add one test that seeds a Markdown FileCard with MIME `application/octet-stream`, clicks it, and expects the full Markdown source inside `workspace-file-body`. Add a second case that routes the PDF media URL to valid fixture bytes, clicks the PDF FileCard, and expects `workspace-pdf-page-1` plus the preserved filename. In both cases assert `message-thread-panel` remains visible and `channel-drop-zone` is hidden after the card opens.

After returning to conversation, assert the original FileCard Download action still invokes `download_file`. Also pass a path-only payload to the attachment opener unit boundary and assert it is rejected rather than presented as a delivered relay attachment.

Use this route shape for deterministic bytes:

```ts
await page.route("https://mock.relay/media/**", async (route) => {
  await route.fulfill({
    body: Buffer.from(validPdfBase64, "base64"),
    contentType: "application/pdf",
    status: 200,
  });
});
```

Store a minimal one-page PDF as a base64 constant in the spec so no binary fixture is committed. The decoded file must begin `%PDF-1.4`, contain one page object, and end `%%EOF`.

- [ ] **Step 2: Build the full E2E application and confirm the cases fail**

Run: `cd desktop && pnpm build:e2e && pnpm exec playwright test tests/e2e/file-attachment.spec.ts`

Expected: FAIL before FileBody recognizes Markdown and PDF presentation.

- [ ] **Step 3: Extend the mock bridge only where the real native boundary requires it**

Keep `fetch_media_bytes` using `fetch(url)` so Playwright route fulfillment remains the proof path. Add no MIME-specific shortcut. If the E2E upload descriptor needs a Markdown variant, pass it through `installMockBridge` in the test rather than adding global branching.

- [ ] **Step 4: Run desktop unit, static, and browser suites**

Run: `cd desktop && pnpm test && pnpm typecheck && pnpm check && pnpm build:e2e && pnpm exec playwright test`

Expected: all desktop package tests and all Playwright projects PASS.

- [ ] **Step 5: Run Rust package suites**

Run: `cargo test -p buzz-cli && cargo test -p buzz-media && cargo test -p buzz-relay`

Expected: all three package suites PASS.

- [ ] **Step 6: Commit end-to-end coverage**

```bash
git add desktop/src/testing/e2eBridge.ts desktop/tests/e2e/file-attachment.spec.ts
git commit -m "test: prove workspace document attachments" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 6: Prove the packaged and live boundary

**Files:**
- No source changes expected.

- [ ] **Step 1: Build and install the local packaged desktop and CLI artifacts**

Run the repository's documented desktop packaging command from `desktop/`, then run the packaged `buzz messages send --channel <test-channel> --file <markdown-path> --content -` and the equivalent PDF command against an isolated test channel.

Expected: each command returns accepted JSON with one `imeta` tag containing `filename`, and neither command reports `unsupported file type`.

- [ ] **Step 2: Drive the packaged Tauri flow**

Open the two posted attachment cards in the packaged app.

Expected: Markdown text renders, the PDF page renders, the originating thread remains as the 20% context pane, and Back to conversation restores the exact prior state.

- [ ] **Step 3: Record the proof boundary**

Record the tested commit from `git rev-parse HEAD`, the CLI JSON event IDs, screenshots, and the installed application build identifier. Do not call the feature live until the released CLI and desktop binaries have adopted that exact commit and the same two attachment flows pass against the production relay.
