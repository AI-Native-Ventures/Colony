/**
 * Isolated interactive website preview host.
 *
 * One `WebContentsView` per preview identity (owner window, community, job,
 * thread root, revision, manifest hash). Each view gets its own ephemeral
 * Electron session partition, a partition-scoped `colony-preview:` protocol
 * that serves only loader-verified file bytes, and a native container used to
 * clip the page to the pane the caller says is visible. There is no preload,
 * no Node integration, no app session, and no IPC surface on this object.
 *
 * Electron dependencies are injected so the lifecycle can be unit tested in
 * plain Node:
 *
 *   const host = createWebsitePreviewHost({ WebContentsView, View, session });
 *
 * `loadPreview` is injectable for the same reason and defaults to the verified
 * loader in `artifact.mjs`.
 */

import { randomBytes } from "node:crypto";

import { loadWebsitePreview } from "./artifact.mjs";
import { PreviewHostError } from "./host-errors.mjs";
import {
  PREVIEW_FIRST_LOAD_TIMEOUT_MS,
  applyEntryBorderRadius,
  detachEntry,
  destroyEntry,
  mountEntry,
} from "./lifecycle.mjs";
import { MAX_TOTAL_BYTES } from "./manifest.mjs";
import {
  normalizeOpenError,
  normalizeRadius,
  requireId,
  resolveZoom,
  scopeKey,
  validateOpenRequest,
} from "./scope.mjs";
import { previewState } from "./state.mjs";
import {
  computePreviewLayout,
  normalizeClip,
  normalizeRect,
} from "./viewport.mjs";

export { PREVIEW_FIRST_LOAD_TIMEOUT_MS };

/** Maximum simultaneously mounted preview views. */
export const PREVIEW_MAX_VIEWS = 4;
/** Bytes reserved for one pending load (the loader's per-site cap). */
export const PREVIEW_LOADING_RESERVE_BYTES = MAX_TOTAL_BYTES;
/** Total verified artifact bytes retained across open and closing views. */
export const PREVIEW_MAX_TOTAL_BYTES = 4 * MAX_TOTAL_BYTES;

const CLIP_STRATEGIES = new Set(["clip", "hide"]);

function invalid(code, message, details) {
  return new PreviewHostError(code, message, details);
}

/**
 * Combine abort signals into one. Combined so a close, a scope invalidation,
 * and the caller's own signal all cancel the loader.
 */
function linkSignals(signals) {
  const usable = signals.filter((signal) => signal !== null);
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];
  const controller = new AbortController();
  const links = new Map();
  const abort = (reason) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    for (const [signal, listener] of links) {
      signal.removeEventListener("abort", listener);
    }
    links.clear();
  };
  for (const signal of usable) {
    if (controller.signal.aborted || signal.aborted) {
      abort(signal.reason);
      return controller.signal;
    }
    const listener = () => abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    links.set(signal, listener);
  }
  return controller.signal;
}

/** Isolated, interactive website preview host. See the module doc. */
export class WebsitePreviewHost {
  constructor(options = {}) {
    const {
      WebContentsView,
      View,
      session,
      loadPreview = loadWebsitePreview,
      clipStrategy = "hide",
      maxViews = PREVIEW_MAX_VIEWS,
      maxTotalBytes = PREVIEW_MAX_TOTAL_BYTES,
    } = options;
    if (typeof WebContentsView !== "function" || typeof View !== "function") {
      throw invalid(
        "invalid_dependencies",
        "WebContentsView and View constructors are required",
      );
    }
    if (
      session === null ||
      typeof session !== "object" ||
      typeof session.fromPartition !== "function"
    ) {
      throw invalid(
        "invalid_dependencies",
        "an Electron session module is required",
      );
    }
    if (typeof loadPreview !== "function") {
      throw invalid("invalid_dependencies", "loadPreview must be a function");
    }
    if (!CLIP_STRATEGIES.has(clipStrategy)) {
      throw invalid(
        "invalid_dependencies",
        "clipStrategy must be clip or hide",
      );
    }
    if (!Number.isSafeInteger(maxViews) || maxViews < 1) {
      throw invalid(
        "invalid_dependencies",
        "maxViews must be a positive integer",
      );
    }
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) {
      throw invalid(
        "invalid_dependencies",
        "maxTotalBytes must be a positive integer",
      );
    }
    this.WebContentsView = WebContentsView;
    this.View = View;
    this.session = session;
    this.loadPreview = loadPreview;
    this.clipStrategy = clipStrategy;
    this.maxViews = maxViews;
    this.maxTotalBytes = maxTotalBytes;
    this.entries = new Map();
    this.byHandle = new Map();
    this.stateListeners = new Set();
    this.closing = new Set();
    this.disposed = false;
  }

  /** Number of open preview views (including ones still opening). */
  get activeCount() {
    return this.entries.size;
  }

  /**
   * Subscribe to scoped state updates (`ready`, `failed`, `closed`). Listeners
   * receive frozen state records and are wrapped so one failure cannot stop
   * delivery. Returns an unsubscribe function.
   */
  subscribe(listener) {
    if (typeof listener !== "function") {
      throw invalid("invalid_request", "subscribe requires a function");
    }
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  emitState(entry, status) {
    if (this.stateListeners.size === 0) return;
    const state = this.stateFor(entry, status);
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state);
      } catch {
        // A state consumer must never break the host.
      }
    }
  }

  assertLive() {
    if (this.disposed) {
      throw invalid("preview_disposed", "the preview host is closed");
    }
  }

  usedBytes() {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.loadedBytes ?? entry.reservedBytes;
    }
    for (const entry of this.closing) {
      total += entry.loadedBytes ?? entry.reservedBytes;
    }
    return total;
  }

  /**
   * Open (or return) one preview view for the exact scope in `request`.
   *
   * Resolves only after the manifest and every file are verified and the
   * native view is mounted, or rejects with a `PreviewHostError`. The signal
   * and any later `close`/community invalidation abort a pending load.
   */
  async open(request) {
    this.assertLive();
    const scope = validateOpenRequest(request);
    const key = scopeKey(scope);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (scope.bounds !== null) {
        existing.bounds = scope.bounds;
        existing.clip = scope.clip;
        existing.zoom = resolveZoom(scope.window, scope.zoom);
        existing.requestedVisible = scope.visible;
        this.applyLayout(existing);
      }
      return existing.promise;
    }
    if (this.entries.size >= this.maxViews) {
      throw invalid(
        "too_many_views",
        `at most ${this.maxViews} preview views may be open`,
      );
    }
    const reserve = Math.min(PREVIEW_LOADING_RESERVE_BYTES, this.maxTotalBytes);
    if (this.usedBytes() + reserve > this.maxTotalBytes) {
      throw invalid("memory_limit", "the preview memory budget is exhausted");
    }

    // The semantic key dedupes an identical scope; the opaque handle is the
    // per-mount generation every caller mutation must present, so a handle
    // from a closed mount can never address a reopened one.
    const handle = randomBytes(16).toString("hex");
    const entry = {
      key,
      handle,
      window: scope.window,
      communityId: scope.communityId,
      jobId: scope.jobId,
      threadRoot: scope.threadRoot,
      revision: scope.revision,
      manifestSha256: scope.manifest.sha256,
      viewport: scope.viewport,
      pixelWidth: scope.pixelWidth,
      pixelHeight: scope.pixelHeight,
      bounds: scope.bounds,
      clip: scope.clip,
      zoom: resolveZoom(scope.window, scope.zoom),
      radius: scope.radius,
      requestedVisible: scope.visible,
      controller: new AbortController(),
      state: "opening",
      disposed: false,
      failed: false,
      lastError: null,
      reservedBytes: reserve,
      loadedBytes: null,
      site: null,
      paths: null,
      token: null,
      partition: null,
      previewSession: null,
      container: null,
      view: null,
      webContents: null,
      zoomFactor: 1,
      layout: null,
      webContentsListeners: [],
      sessionListeners: [],
      protocolHandled: false,
      clearWebRequest: null,
      removeWindowListener: null,
      cspByPath: new Map(),
      inlineScriptsTruncated: false,
      onInlineTruncated: null,
      cleanup: null,
      promise: null,
    };
    const onClosed = () => {
      void this.closeAllForWindow(scope.window);
    };
    scope.window.once("closed", onClosed);
    entry.removeWindowListener = () => {
      try {
        scope.window.removeListener?.("closed", onClosed);
      } catch {
        // Removing a listener from a destroyed window must not throw.
      }
    };
    this.entries.set(key, entry);
    this.byHandle.set(handle, entry);
    entry.onInlineTruncated = () => this.emitState(entry);
    entry.promise = this.start(entry, scope);
    entry.promise.catch(() => {});
    return entry.promise;
  }

  start(entry, scope) {
    return (async () => {
      try {
        const signal = linkSignals([entry.controller.signal, scope.signal]);
        const site = await this.loadPreview({
          manifestRef: {
            url: scope.manifest.url,
            sha256: scope.manifest.sha256,
          },
          signal: signal ?? undefined,
        });
        if (entry.disposed) {
          throw invalid("preview_closed", "preview was closed before it opened");
        }
        this.verifySite(entry, site);
        await mountEntry(this, entry);
        if (entry.disposed) {
          throw invalid("preview_closed", "preview was closed before it opened");
        }
        entry.state = "ready";
        const state = this.stateFor(entry);
        this.emitState(entry);
        return state;
      } catch (error) {
        // Normalize BEFORE starting teardown: teardown marks the entry
        // disposed, which would otherwise mask the real failure code.
        const normalized = normalizeOpenError(entry, error);
        void this.beginClose(entry);
        throw normalized;
      }
    })();
  }

  verifySite(entry, site) {
    if (
      site === null ||
      typeof site !== "object" ||
      typeof site.getFile !== "function" ||
      !Array.isArray(site.files) ||
      typeof site.entrypoint !== "string"
    ) {
      throw invalid(
        "invalid_artifact",
        "the loader returned no verified site",
      );
    }
    if (site.manifestSha256 !== entry.manifestSha256) {
      throw invalid(
        "manifest_mismatch",
        "the loaded manifest hash does not match the requested revision",
      );
    }
    const paths = new Set();
    let total = 0;
    for (const file of site.files) {
      if (
        file === null ||
        typeof file !== "object" ||
        typeof file.path !== "string" ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0
      ) {
        throw invalid(
          "invalid_artifact",
          "the verified file list is malformed",
        );
      }
      if (paths.has(file.path)) {
        throw invalid(
          "invalid_artifact",
          "the verified file list has duplicates",
        );
      }
      paths.add(file.path);
      total += file.size;
      if (total > MAX_TOTAL_BYTES) {
        throw invalid(
          "artifact_too_large",
          "the verified artifact exceeds 64 MiB",
        );
      }
    }
    if (!paths.has(site.entrypoint)) {
      throw invalid(
        "entrypoint_missing",
        "the entrypoint is not a listed file",
      );
    }
    const used = this.usedBytes() - entry.reservedBytes;
    if (used + total > this.maxTotalBytes) {
      throw invalid("memory_limit", "the preview memory budget is exhausted");
    }
    entry.site = site;
    entry.paths = paths;
    entry.loadedBytes = total;
    entry.reservedBytes = 0;

    // The entrypoint bytes must exist up front so a malformed loader cannot
    // mount a view that can never paint. Inline authorizations are computed
    // per served HTML page by the request layer, not here.
    const entrypoint = site.getFile(site.entrypoint);
    if (entrypoint === null || !Buffer.isBuffer(entrypoint.bytes)) {
      throw invalid("invalid_artifact", "the verified entrypoint has no bytes");
    }
  }

  applyLayout(entry) {
    if (entry.disposed || entry.container === null || entry.view === null) return;
    const layout =
      entry.bounds === null
        ? { visible: false }
        : computePreviewLayout({
            bounds: entry.bounds,
            clip: entry.clip,
            zoom: entry.zoom,
            pixelWidth: entry.pixelWidth,
            pixelHeight: entry.pixelHeight,
            clipStrategy: this.clipStrategy,
          });
    entry.layout = layout;
    const visible =
      entry.requestedVisible && layout.visible === true && !entry.failed;
    if (layout.visible === true) {
      entry.container.setBounds(layout.container);
      entry.view.setBounds(layout.child);
      if (entry.zoomFactor !== layout.zoomFactor) {
        entry.zoomFactor = layout.zoomFactor;
        try {
          entry.webContents.setZoomFactor(layout.zoomFactor);
        } catch {
          // The view may be mid-teardown; zoom will be re-applied if it loads.
        }
      }
    }
    try {
      entry.container.setVisible(visible);
      entry.view.setVisible(visible);
    } catch {
      // Visibility failures are recovered on the next update.
    }
  }

  /**
   * Reposition and refit without changing the requested visibility.
   *
   * A handle from a closed mount returns `null`: it can never address the
   * reopened scope, which has a different handle.
   */
  updateBounds({ window, handle, bounds, clip, zoom, radius } = {}) {
    this.assertLive();
    const entry = this.findLiveEntry(window, handle);
    if (entry === null) return null;
    entry.bounds = normalizeRect(bounds);
    entry.clip = normalizeClip(clip);
    entry.zoom = resolveZoom(entry.window, zoom);
    const nextRadius = normalizeRadius(radius);
    if (nextRadius !== undefined) entry.radius = nextRadius;
    applyEntryBorderRadius(entry);
    this.applyLayout(entry);
    return this.stateFor(entry);
  }

  /** Show or hide the mounted view; hidden views keep their geometry. */
  setVisible({ window, handle, visible } = {}) {
    this.assertLive();
    const entry = this.findLiveEntry(window, handle);
    if (entry === null) return null;
    entry.requestedVisible = visible === true;
    this.applyLayout(entry);
    return this.stateFor(entry);
  }

  /**
   * Close one preview by its per-mount handle. An unknown or stale handle is
   * a no-op so a late close after a community invalidation is harmless.
   */
  async close({ window, handle } = {}) {
    this.assertLive();
    if (typeof handle !== "string" || handle === "") {
      throw invalid("invalid_request", "close requires a preview handle");
    }
    const entry = this.findLiveEntry(window, handle);
    if (entry === null) return;
    await this.beginClose(entry);
  }

  /**
   * Invalidate every preview for a community. Entries are removed and
   * detached synchronously, so a business switch cannot be raced by a view
   * that is still mounting; the returned promise is the async teardown of
   * sessions, web contents, and protocol handlers.
   */
  async closeAllForCommunity(communityId) {
    this.assertLive();
    requireId(communityId, "communityId");
    const pending = [];
    for (const entry of [...this.entries.values()]) {
      if (entry.communityId === communityId) {
        pending.push(this.beginClose(entry));
      }
    }
    await Promise.allSettled(pending);
  }

  /** Invalidate every preview owned by one window (window teardown). */
  async closeAllForWindow(window) {
    const pending = [];
    for (const entry of [...this.entries.values()]) {
      if (entry.window === window) pending.push(this.beginClose(entry));
    }
    await Promise.allSettled(pending);
  }

  /**
   * Invalidate every live preview without disposing the host. Synchronous
   * detach runs for every entry before this returns; the promise is the async
   * teardown. Used on renderer reload, sign-out, and business switches.
   */
  async invalidateAll() {
    const pending = [];
    for (const entry of [...this.entries.values()]) {
      pending.push(this.beginClose(entry));
    }
    await Promise.allSettled(pending);
  }

  /** Invalidate every preview and mark the host closed (app shutdown). */
  async closeAll() {
    this.disposed = true;
    const pending = [];
    for (const entry of [...this.entries.values()]) {
      pending.push(this.beginClose(entry));
    }
    await Promise.allSettled(pending);
    await this.whenIdle();
  }

  /** Resolve once every closing entry has finished its async teardown. */
  async whenIdle() {
    await Promise.allSettled([...this.closing].map((entry) => entry.cleanup));
  }

  findLiveEntry(window, handle) {
    if (typeof handle !== "string" || handle === "") {
      throw invalid("invalid_request", "a preview handle is required");
    }
    const entry = this.byHandle.get(handle);
    if (entry === undefined || entry.disposed) return null;
    if (entry.window !== window) {
      throw invalid("wrong_window", "preview belongs to another window");
    }
    return entry;
  }

  /** Frozen state snapshot for tests and diagnostics. */
  stateFor(entry, status) {
    return previewState(entry, status);
  }

  beginClose(entry) {
    if (entry.disposed) return entry.cleanup ?? Promise.resolve();
    entry.disposed = true;
    entry.state = "closed";
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (this.byHandle.get(entry.handle) === entry) {
      this.byHandle.delete(entry.handle);
    }
    this.closing.add(entry);
    try {
      entry.controller.abort(invalid("preview_closed", "preview was closed"));
    } catch {
      entry.controller.abort();
    }
    try {
      entry.removeWindowListener?.();
    } catch {
      // The window may already be destroyed.
    }
    entry.removeWindowListener = null;
    detachEntry(entry);
    this.emitState(entry, "closed");
    entry.cleanup = (async () => {
      await destroyEntry(entry);
      this.closing.delete(entry);
    })();
    return entry.cleanup;
  }
}

/** Construct the host after `app.whenReady()` with Electron's classes. */
export function createWebsitePreviewHost(options) {
  return new WebsitePreviewHost(options);
}
