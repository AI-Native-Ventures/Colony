# Website preview host

Status: **host implemented; `main.mjs` and the shared client are integrated;
native proof pending.** The loader is verified and frozen, the host and its
safety mechanisms are covered by source tests with injected Electron
dependencies, and the trusted dispatcher now exposes preview operations with
an authoritative business generation. No native clipping or rendered-behavior
claim below is proven until
`.github/workflows/website-preview-native-proof.yml` runs the real-Electron
fixture proof green on the target platform. Production clipping stays on the
safe `hide` fallback until the pixel proof passes.

This document is the contract for the native side of the preview flow in
`docs/website-manager-protocol.md` section 1. The manifest is immutable and is
identified by the SHA-256 of its exact published bytes.

Source lives in `desktop/src-electron/website-preview/`:

| file | responsibility |
| --- | --- |
| `errors.mjs` | `PreviewArtifactError` with a stable `code` (loader) |
| `address.mjs` | `isPrivateAddress`, name/host classification (loader) |
| `manifest.mjs` | limits, path/URL/MIME/SHA-256 validation, strict parse (loader) |
| `network.mjs` | pinned-address HTTPS fetch, DNS checks, bounded redirects (loader) |
| `artifact.mjs` | `loadWebsitePreview` loader and public re-exports (loader) |
| `host-errors.mjs` | `PreviewHostError` with a stable `code` |
| `scope.mjs` | scope validation, semantic identity key, abort/error mapping |
| `state.mjs` | frozen scoped state records |
| `scheme.mjs` | scheme descriptor, one strict URL parser, MIME/CSP headers |
| `inline-script.mjs` | byte-exact inline script and event handler hashing |
| `serving.mjs` | pure request-to-verified-file resolution with per-page CSP |
| `viewport.mjs` | pure fit/clip math and application-zoom conversion |
| `lifecycle.mjs` | mount, first-load wait, security handlers, teardown |
| `artifacts.mjs` | bounded `loadVerifiedArtifact` for single refs |
| `handover.mjs` | staged, symlink-safe, recoverable handover download |
| `host.mjs` | `WebsitePreviewHost` and `createWebsitePreviewHost` |
| `proof.mjs` | real-Electron fixture proof (run with Electron, not Node) |
| `host.test.mjs`, `viewport.test.mjs`, `inline-script.test.mjs`, `handover.test.mjs`, `host-test-support.mjs` | source tests and doubles |
| `artifact.test.mjs`, `transport.test.mjs`, `artifact-immutability.test.mjs` | loader tests |

The shared renderer client is `desktop/src/shared/api/websitePreview.ts`.

## Loader API

```js
import { loadWebsitePreview } from "./artifact.mjs";

const site = await loadWebsitePreview({ manifestRef }); // production
const site = await loadWebsitePreview({ manifestRef, dependencies }); // tests
```

- `manifestRef` is `{ url, sha256 }`; `sha256` covers the raw manifest bytes.
- `dependencies` is `undefined` for real DNS + HTTPS, or an explicit
  `{ lookup, open }` pair for tests. Partial injection throws
  `invalid_dependencies`; there is no environment-variable bypass.
- `timeoutMs` (default 15000) caps one request; `deadlineMs` (default 120000)
  caps the load; `maxRedirects` (default 5) is bounded to 10.
- `signal` cancels; abort produces `aborted`, deadlines produce `timeout`.

The resolved value is deeply frozen and is produced only after the manifest and
**every** listed file have been fetched and verified:

```js
{
  schema, entrypoint, manifestSha256,
  files,             // frozen metadata records (path, url, mime, size, sha256, contentType)
  entrypointFile,    // frozen metadata record for the entrypoint (no bytes)
  getFile(path),     // frozen metadata + a fresh `bytes` copy, or null
}
```

## Enforced loader invariants

- Bounds: manifest <= 256 KiB, <= 512 files, file <= 16 MiB, total <= 64 MiB,
  path <= 1024 bytes, URL <= 2048 bytes, sizes non-negative safe integers.
- Manifest: exact schema, unknown fields rejected, case-folded path collisions
  rejected, entrypoint exists and is `text/html`, raw-byte digest matches.
- Paths: literal relative paths only; no absolute/trailing slash, backslash,
  `%`, `?`, `#`, control characters, empty/`.`/`..` segments, or trailing
  space/dot segments.
- URLs: absolute HTTPS, no userinfo, no fragment, bounded. Host must be public
  without DNS.
- Every DNS answer for every hop is checked; any private, loopback, link-local,
  CGNAT, benchmarking, multicast, ULA, NAT64, Teredo, 6to4, documentation, or
  IPv4-mapped result rejects the load. The first resolution is pinned as the
  socket host; SNI and Host keep the name, so TLS verification still applies.
- Redirects are bounded, re-validated, and re-resolved per hop; responses are
  discarded before the next hop.
- Each hop is bounded by `timeoutMs` and the whole load by `deadlineMs`; late
  responses and sockets are destroyed. Requests carry no cookies,
  authorization, or proxy credentials.

## Host API

Construct after `app.whenReady()`:

```js
const previews = createWebsitePreviewHost({ WebContentsView, View, session });
previews.subscribe((state) =>
  send({ type: "website-preview", payload: state }),
);
resources.add(() => previews.closeAll());
```

Options: `loadPreview` (test injection only), `clipStrategy` (`"hide"`
default; `"clip"` is opt-in after native proof), `maxViews` (default 4),
`maxTotalBytes` (default 256 MiB). Missing or malformed dependencies throw
`invalid_dependencies` rather than falling back.

### Identity, handles, and lifecycle

One view per exact identity:

```
owner window + communityId + jobId + threadRoot + revision + manifestSha256 + viewport
```

`viewport` is part of the identity, so the same job, revision, and hash at
another viewport is a separate view and never silently returns the old
dimensions. Pixel sizes must be the canonical `1440x900` desktop or `390x844`
mobile; any other size is refused with `invalid_viewport`.

`open` is idempotent for a live scope: it returns the same shared view. The
result carries two identifiers:

- `scopeId`: the deterministic semantic key above (diagnostics and dedup).
- `handle`: an opaque 32-hex value unique to this mount. Every mutation
  (`updateBounds`, `setVisible`, `close`) takes the handle. Closing and
  reopening the same scope mints a new handle, so a stale handle from the old
  mount returns `null` (or is ignored by `close`) and can never address the new
  view (no ABA).

`open` resolves `ready` only after the manifest and every file are verified
**and the first main-frame load finished**. A failed, aborted, or timed-out
first load rejects with a typed error and fully tears down: no blank view is
ever labelled interactive. Later `did-fail-load` or `render-process-gone`
marks the entry failed, hides it, and pushes a scoped `failed` state through
`subscribe`. `close` pushes `closed`. State records contain identity, status
(`opening`/`ready`/`failed`/`closed`), `visible`, `inlineScriptsTruncated`,
and an error string; they contain no secrets.

### Methods

- `open(request)` fields: `window`, `communityId`, `jobId`, `threadRoot`,
  `revision`, `manifest` (`{url, sha256}`), `viewport`, `pixelWidth`,
  `pixelHeight`, optional `bounds` (full, unclipped element rect in app CSS
  px), optional `clip` (`{top,left,right,bottom}`), optional `zoom` (defaults
  to the owning window's `webContents.getZoomFactor()`), optional `radius`,
  optional `visible`, optional `signal`.
- `updateBounds({ window, handle, bounds, clip, zoom, radius })`.
- `setVisible({ window, handle, visible })`.
- `close({ window, handle })`; unknown/stale handles are a no-op.
- `closeAllForCommunity(communityId)`, `invalidateAll()`,
  `closeAllForWindow(window)`, `closeAll()`, `whenIdle()`, `subscribe(fn)`,
  `activeCount`.

`closeAllForCommunity` and `invalidateAll` detach every matching view
**synchronously** and return a promise for the async teardown, so a business
switch or reload cannot be raced by a late load.

## Host security invariants

- **Ephemeral, per-mount sessions.**
  `session.fromPartition("preview-<32 hex>")` with no `persist:` prefix. Never
  `BrowserViews.sessionFor`, never the app session. Nothing from the signed-in
  business (cookies, storage, cache, proxy, auth) is reachable from a preview.
- **Sandboxed renderer.** `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, no Node in workers or subframes,
  `webSecurity: true`, `allowRunningInsecureContent: false`,
  `webviewTag: false`, `devTools: false`, `disableDialogs: true`, and no
  `preload`. The host registers no `ipcMain` handlers and exposes no preload
  API of its own.
- **Only verified bytes are served.** The partition-scoped
  `session.protocol.handle("colony-preview", ...)` (never global `protocol`)
  resolves requests through the same `parsePreviewUrl` used by navigation:
  exact token, no credentials, no port, normalized literal path, `""` mapped
  to the verified entrypoint, exact listed path lookup, `GET` only. No
  filesystem, no `file://`, no network fallthrough, no partial bytes.
- **Correct MIME and headers.** Manifest `mime` is authoritative, textual
  types get `; charset=utf-8`, and every response carries `nosniff` and
  `no-store`.
- **Restrictive CSP with verified inline hashes, per served page.**
  `default-src 'none'`; every `text/html` response computes `script-src`
  hashes from that document's own verified bytes, cached per path, so a
  verified second page with its own inline menu or tab script works.
  `script-src` is `'self'`
  `'wasm-unsafe-eval'` plus `'sha256-...'` tokens, and `'unsafe-hashes'` plus
  handler hashes for inline event handler attributes. There is no code path
  that adds `'unsafe-inline'` to `script-src`; inline content not present in a
  verified document stays blocked. Up to 128 tokens per page are authorized;
  beyond that `inlineScriptsTruncated` flips to true, a scoped state update is
  pushed, and the extra scripts stay blocked as a visible, recoverable
  unsupported state rather than a silently broken preview. `style-src 'self'
  'unsafe-inline'`, `img-src 'self' data: blob:`, `connect-src 'self'`,
  `worker-src 'none'`, `frame-src 'none'`, `object-src 'none'`,
  `form-action 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`.
- **Network, frames, and plugins are refused twice.** CSP plus a
  partition-scoped `webRequest.onBeforeRequest` that cancels every URL outside
  the entry's own `colony-preview://<token>/` origin.
- **Navigation is origin-locked.** `will-navigate`, `will-redirect`, and
  `will-frame-navigate` allow only listed files on the entry's own random
  host; `setWindowOpenHandler` denies popups; `will-attach-webview` is
  prevented.
- **Permissions and downloads denied.** Session permission request and check
  handlers return false; `will-download` prevents and cancels.
- **No capture substitute.** The interactive surface is the live
  `WebContentsView`; `capturePage` is never used as the interactive view.

## Viewport fitting and clipping

The page keeps its real CSS viewport. The host sizes the native view in
content pixels and derives `webContents.setZoomFactor(fittedWidthDip /
pixelWidth)` from the actual fitted width, so the CSS viewport stays at the
canonical size while the native view fits the pane without cropping. Integer
rounding means the CSS height can differ by less than one CSS pixel; the real
proof measures and reports that tolerance instead of asserting an exact
height.

`bounds` is the full, unclipped element rect and `clip` is the visible app
region, both in app CSS pixels. The host intersects them, sizes the container
`View` to the intersection, and offsets the child so the visible slice stays
aligned. Scrolling under a header clips instead of rescaling.

- `clipStrategy: "hide"` (default): any partial occlusion hides the view. Safe
  and documented; it does not depend on child-clipping behavior.
- `clipStrategy: "clip"` (opt-in): the container `View` is used as the clip.
  This depends on a child `WebContentsView` being painted only inside its
  parent `View` bounds, which is measured by `proof.mjs` and remains the one
  undocumented Electron assumption. Do not make it the default until the
  pixel proof is green on every shipped platform.

### Frontend mapping

`websitePreview.ts` exposes `WebsitePreviewNativeAdapter.attach(container,
request, signal)`. `container` is accepted for interface compatibility but
unused: the preview is a native overlay, and geometry arrives through
`setBounds`. The feature hook must pass the **unclipped** element rect plus the
clip rect and app zoom:

```ts
handle.setBounds({
  bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
  clip: clipRef.current?.() ?? null,
  zoom: window.webContents?.getZoomFactor?.() ?? 1,
});
```

Applying `intersectHostBounds` first and passing only the clipped rect makes
the fit input shrink while scrolling, so the preview appears to rescale.
`intersectHostBounds` remains correct for the DOM placeholder, not for the
native handle.

## Integration API (implemented)

The trusted dispatcher in `main.mjs` validates `event.sender`,
`event.senderFrame`, and the trusted URL before any case runs. Preview
operations reuse that dispatcher; there is no second IPC channel and no
permissive path through terminal IPC.

| request type | payload | notes |
| --- | --- | --- |
| `website-preview:open` | open request plus `communityId` | requires the current `businessContext` and a matching community |
| `website-preview:bounds` | `{ communityId, handle, bounds, clip, zoom, radius }` | |
| `website-preview:visible` | `{ communityId, handle, visible }` | |
| `website-preview:close` | `{ communityId, handle }` | stale handles are a no-op |
| `website-artifact:load` | `{ communityId, manifest }` | bounded to 16 MiB, digest re-verified, generation re-checked |
| `website-handover:download` | `{ communityId, items }` | opens the directory picker in main |

Every request must carry the expected `communityId`, checked against the live
business context. The trusted `window` is applied **last**
(`{ ...payload, window }`), so a payload can never substitute another window.
The dispatcher captures `{ context, generation }` before async work, links an
`AbortController` to business invalidation, aborts in-flight fetches, and
re-checks the captured context and generation after the await and before any
bytes are returned or handover files are finalized. State updates are pushed as
`{ type: "website-preview", payload: state }` over the existing
`colony:event` subscription.

Business invalidation is synchronous and rotates the generation at four points:

1. `business` context switch: `invalidatePreviews()` rotates the generation,
   aborts in-flight website work, and detaches every live preview before the
   new context is installed.
2. `import_identity` / `sign_out`: the same invalidation.
3. Renderer main-frame navigation/reload: the same invalidation.
4. Owner window close and app cleanup: an aborting resource closure plus
   `previews.closeAll()`.

A pending load that completes after any of these is aborted by its entry
controller and can never mount: `open` checks `entry.disposed` after the load
and after the first-frame wait.

### Shared client

`desktop/src/shared/api/websitePreview.ts` exports:

- `isWebsitePreviewAvailable()`
- `subscribeWebsitePreviewState(listener)` and
  `subscribeWebsitePreviewHandle(handle, listener)` so a card can observe
  `failed` and `closed` for its own handle.
- `createWebsitePreviewAdapter({ onState, onError })` returning a
  `WebsitePreviewNativeAdapter` or `null` without the Electron shell. A late
  attach after `signal` aborts closes its handle before rejecting, a non-ready
  open result is closed instead of reported interactive, and `setBounds`,
  `setVisible`, and `close` failures are delivered to `onError` because the
  feature handle contract is synchronous.
- `loadWebsiteArtifact(ref, communityId, signal)` which asks the native side
  for the bounded verified bytes, re-verifies the digest locally with
  WebCrypto, and returns a revocable blob URL.
- `createWebsiteArtifactLoader(communityId)` binding that loader to the
  feature `WebsiteArtifactLoader` shape.
- `downloadWebsiteHandover(items, communityId)` for approved source/assets.

A thin website UI adapter (frontend-owned) maps the feature element and clip
rectangles to `setBounds`; this module keeps only the stable native contract.

## Handover download

`website-handover:download` accepts canonical artifact refs
`{ path, url, sha256 }` (a `size` is optional and, when present, must match
exactly; callers must not invent sizes). Every item is fetched into a fresh
private staging directory created with `mkdtemp` under the chosen location.
All digests and declared sizes are verified there before anything is
finalized. Finalization walks each destination directory with `lstat`, refuses
to follow or replace symlinks and non-directories, and hard-links without
overwrite.

The result is frozen and recoverable:

```js
{
  directory,        // chosen root
  complete,         // no failed items
  files,            // newly written { path, sha256, size }
  alreadyPresent,   // destinations that already held the approved bytes
  failed,           // { path, code, message }; user files were preserved
}
```

Cancellation before staging throws `handover_cancelled` and creates nothing.
A digest or size failure removes staging and finalizes nothing. The main
process passes `assertCurrent`, which re-checks the captured business context
and generation after the directory picker resolves and again after staging,
before any file is finalized. A partial finalize leaves only verified files in
place; a retry sees matching destinations as `alreadyPresent` and only retries
`failed` items. Only the staging directory this call created is ever removed.

## Real-Electron proof

`.github/workflows/website-preview-native-proof.yml` runs
`desktop/src-electron/website-preview/proof.mjs` with the repository's Electron
on `macos-15`. The workflow reruns on changes to the proof, the host, the
preview integration in `main.mjs`, the preload, and the shared client. The
proof registers the same `PREVIEW_SCHEME_DESCRIPTOR` before `app.whenReady()`
as production, mounts an in-process fixture artifact (no network) through real
`View`, `WebContentsView`, and `session` objects, and checks:

- desktop and mobile `innerWidth`, `innerHeight`, and `matchMedia` with the
  measured rounding tolerance;
- inline script and inline handler execution on the entrypoint **and on a
  second verified HTML page**, each under its own hash-authorized CSP;
- denial of external navigation, popups, permissions, and network fetches;
- cross-entry navigation denial and distinct preview partitions;
- close teardown (web contents unusable, zero active previews);
- a composited-window pixel sample for container clipping via
  `desktopCapturer`, reported `proven`, `failed`, or `unavailable` when the OS
  withholds screen capture. The workflow rejects `failed` and does not treat
  `unavailable` as proof.

This is host-fixture proof. It does not prove packaged Colony adoption, the
production artifact loader against a real CDN, relay review integration, or
frontend adoption; those remain separate gates.

## Error codes

Loader codes pass through unchanged (see `errors.mjs`). Host codes:
`invalid_scope`, `invalid_viewport`, `invalid_window`, `invalid_signal`,
`invalid_request`, `invalid_bounds`, `invalid_clip`, `invalid_zoom`,
`invalid_radius`, `invalid_artifact`, `manifest_mismatch`, `artifact_too_large`,
`entrypoint_missing`, `too_many_views`, `memory_limit`, `preview_closed`,
`preview_aborted`, `preview_load_failed`, `preview_load_timeout`,
`preview_renderer_gone`, `unknown_preview`, `wrong_window`, `preview_disposed`,
`invalid_dependencies`, `session_failed`, `view_failed`, `window_closed`,
`artifact_digest_mismatch`, `handover_cancelled`, `handover_conflict`,
`handover_duplicate_path`, `handover_size_mismatch`, `handover_too_large`,
`invalid_handover`, `handover_write_failed`.

## Remaining unproven gates

Exact limits of the current evidence:

1. The native clipping pixel proof has not run; `"hide"` remains the
   production default and `"clip"` is not adopted. `desktopCapturer` may be
   unavailable on a CI runner; that is recorded as `unavailable`, not proof.
2. Second-page CSP behavior is proven by source tests and by the fixture proof
   only. Real generated sites with unusual inline constructs (template-literal
   scripts containing `</script>` text, attribute values with entities we do
   not decode, or more than 128 inline scripts) may degrade to the visible
   `inlineScriptsTruncated` state; none of that is proven against a real
   generator output yet.
3. The frontend feature hook still clips before calling the native handle
   (`desktop/src/features/website` is owned by the frontend worker); the
   adapter mapping in this document is the required correction.
4. The production loader path against a real public CDN and the relay review
   record integration are not exercised by the fixture proof.
5. Business-generation re-checks are unit-proven at the handover and host
   levels; the full switch/reload race against real IPC timing is not yet
   exercised end to end.
6. Packaged Colony adoption (real window, real user flows, real artifacts)
   has not been demonstrated.
