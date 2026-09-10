/**
 * Typed native contract for the isolated website preview host.
 *
 * Everything here goes through the existing trusted `colonyDesktop.request`
 * transport (`electronNativeBridge`), which is backed by the single
 * `colony:request` dispatcher that verifies the sender, main frame, and
 * trusted URL. No new IPC channel, no preload addition, and no secret or
 * cookie ever appears in a result object.
 *
 * Every request carries the expected `communityId`. The main process checks
 * it against the live business context, captures that context plus its
 * generation, aborts the request when the context changes, and re-checks
 * before returning bytes or finalizing a handover, so a late async result can
 * never land under the next business.
 *
 * Frontend integration maps the feature layer's element and clip rectangles
 * into `setBounds`: `bounds` is the full, unclipped element rect in app CSS
 * pixels and `clip` is the visible window region. Passing a clipped rect as
 * `bounds` makes the preview rescale while scrolling, so the feature hook
 * should pass both. A thin website UI adapter owns that mapping; this module
 * only defines the stable native contract.
 */

import { electronDesktop } from "./electronNativeBridge";

export type WebsitePreviewViewportName = "desktop" | "mobile";

export type WebsitePreviewRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WebsitePreviewClip = {
  top: number;
  left: number;
  right: number;
  bottom: number;
};

export type WebsiteArtifactRefLike = {
  url: string;
  sha256: string;
};

export type WebsitePreviewAttachRequest = {
  communityId: string;
  jobId: string;
  threadRoot: string;
  revision: number;
  manifest: WebsiteArtifactRefLike;
  viewport: WebsitePreviewViewportName;
  pixelWidth: number;
  pixelHeight: number;
  bounds?: WebsitePreviewRect;
  clip?: WebsitePreviewClip | null;
  zoom?: number;
  radius?: number;
  visible?: boolean;
};

export type WebsitePreviewState = {
  handle: string;
  scopeId: string;
  communityId: string;
  jobId: string;
  threadRoot: string;
  revision: number;
  manifestSha256: string;
  viewport: WebsitePreviewViewportName;
  pixelWidth: number;
  pixelHeight: number;
  status: "opening" | "ready" | "failed" | "closed";
  visible: boolean;
  inlineScriptsTruncated: boolean;
  error: string | null;
};

/**
 * One bounds update in app CSS pixels, matching the feature
 * `WebsiteHostBoundsUpdate`. `element` is the full, unclipped element rect and
 * `clip` is the visible app window; the host intersects them itself and
 * derives the fit from `element`. `intersection` is informational and ignored.
 *
 * No zoom factor is sent: the app pins the native webview zoom to 1
 * (`useWebviewZoomShortcuts`) and scales text through the root font-size, so
 * `getBoundingClientRect()` values are already in window coordinates.
 */
export type WebsitePreviewBoundsUpdate = {
  element: WebsitePreviewRect;
  clip: WebsitePreviewClip | null;
  intersection?: WebsitePreviewRect | null;
  visible: boolean;
};

/** Minimal handle state, matching the feature `WebsiteNativeHandleState`. */
export type WebsiteNativeHandleStateLike = {
  status: "opening" | "ready" | "failed" | "closed";
  visible: boolean;
  error?: string | null;
};

export type WebsitePreviewHandle = {
  readonly handle: string;
  readonly scopeId: string;
  setBounds(update: WebsitePreviewBoundsUpdate): void;
  setVisible(visible: boolean): void;
  close(): Promise<void>;
  /** Scoped state stream for this exact handle; stale handles never fire. */
  subscribe(
    listener: (state: WebsiteNativeHandleStateLike) => void,
  ): () => void;
};

export type WebsitePreviewRequestError = {
  handle: string;
  operation: "setBounds" | "setVisible" | "close";
  error: unknown;
};

export type WebsiteLoadedArtifact = {
  /** Blob URL over locally re-verified bytes; revoke when unmounted. */
  objectUrl: string;
  verifiedSha256: string;
  revoke: () => void;
};

export type WebsiteArtifactLoaderLike = {
  load(
    ref: WebsiteArtifactRefLike,
    signal?: AbortSignal,
  ): Promise<WebsiteLoadedArtifact>;
};

export type WebsiteHandoverItem = {
  path: string;
  url: string;
  sha256: string;
  /** Optional; when present the fetched length must equal it exactly. */
  size?: number;
};

export type WebsiteHandoverFile = {
  path: string;
  sha256: string;
  size: number;
};

export type WebsiteHandoverResult = {
  directory: string;
  /** True only when every item was written or already present. */
  complete: boolean;
  files: WebsiteHandoverFile[];
  /** Destinations that already held the approved bytes (safe retry). */
  alreadyPresent: WebsiteHandoverFile[];
  /** Items a retry should attempt again; user files are never overwritten. */
  failed: Array<{ path: string; code: string; message: string }>;
};

export type WebsitePreviewAdapterEvents = {
  /** Scoped state for this adapter's handles (`ready`, `failed`, `closed`). */
  onState?: (state: WebsitePreviewState) => void;
  /** Update and close failures, so a card never silently shows a stale view. */
  onError?: (failure: WebsitePreviewRequestError) => void;
};

/**
 * Native adapter. `container` is accepted for interface compatibility with
 * the feature contract but is not used: the preview is a native view, and
 * geometry arrives through `setBounds`.
 */
export type WebsitePreviewNativeAdapter = {
  isAvailable(): boolean;
  attach(
    container: unknown,
    request: WebsitePreviewAttachRequest,
    signal?: AbortSignal,
  ): Promise<WebsitePreviewHandle>;
};

function abortError(): Error {
  return new DOMException("The preview attach was aborted", "AbortError");
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function isWebsitePreviewAvailable(): boolean {
  return electronDesktop() !== undefined;
}

/**
 * Extract the stable native error code from a rejected request.
 *
 * The trusted transport prefixes typed native failures as
 * `"<code>: <message>"`; a plain failure has no prefix and returns null. This
 * never guesses a code from unrelated message text.
 */
export function websitePreviewErrorCode(error: unknown): string | null {
  if (typeof error !== "string") return null;
  const match = /^([a-z][a-z0-9_]*): /.exec(error);
  return match === null ? null : match[1];
}

/** Subscribe to every scoped host state update. */
export function subscribeWebsitePreviewState(
  listener: (state: WebsitePreviewState) => void,
): () => void {
  const api = electronDesktop();
  if (!api) return () => {};
  return api.subscribe((message) => {
    if (message.type !== "website-preview") return;
    listener(message.payload as WebsitePreviewState);
  });
}

/** Subscribe to state for one handle only. */
export function subscribeWebsitePreviewHandle(
  handle: string,
  listener: (state: WebsitePreviewState) => void,
): () => void {
  return subscribeWebsitePreviewState((state) => {
    if (state.handle === handle) listener(state);
  });
}

/**
 * Create the native adapter, or `null` when the Electron shell is absent.
 *
 * A late attach resolution after `signal` aborts closes its handle before
 * rejecting, and a non-ready open result is closed rather than reported as
 * interactive. Geometry and visibility failures are delivered to `onError`
 * because the feature handle contract is synchronous.
 */
export function createWebsitePreviewAdapter(
  events: WebsitePreviewAdapterEvents = {},
): WebsitePreviewNativeAdapter | null {
  const api = electronDesktop();
  if (!api) return null;
  return {
    isAvailable: () => true,
    async attach(_container, request, signal) {
      if (isAborted(signal)) throw abortError();
      const { communityId } = request;
      const state = await api.request<WebsitePreviewState>(
        "website-preview:open",
        { ...request },
      );
      if (isAborted(signal) || state.status !== "ready") {
        await api
          .request("website-preview:close", {
            communityId,
            handle: state.handle,
          })
          .catch(() => {});
        if (isAborted(signal)) throw abortError();
        throw new Error(`The preview host reported ${state.status}`);
      }
      const unsubscribe = events.onState
        ? subscribeWebsitePreviewHandle(state.handle, events.onState)
        : () => {};
      const report = (
        operation: WebsitePreviewRequestError["operation"],
        error: unknown,
      ) => {
        events.onError?.({ handle: state.handle, operation, error });
      };
      let visible = state.visible;
      const applyVisible = (next: boolean) => {
        if (next === visible) return;
        visible = next;
        void api
          .request("website-preview:visible", {
            communityId,
            handle: state.handle,
            visible: next,
          })
          .catch((error) => report("setVisible", error));
      };
      return {
        handle: state.handle,
        scopeId: state.scopeId,
        setBounds(update) {
          void api
            .request("website-preview:bounds", {
              communityId,
              handle: state.handle,
              bounds: update.element,
              clip: update.clip,
            })
            .catch((error) => report("setBounds", error));
          applyVisible(update.visible === true);
        },
        setVisible(next) {
          applyVisible(next === true);
        },
        subscribe(listener) {
          return subscribeWebsitePreviewHandle(state.handle, (next) => {
            listener({
              status: next.status,
              visible: next.visible,
              error: next.error,
            });
          });
        },
        close: async () => {
          unsubscribe();
          await api
            .request("website-preview:close", {
              communityId,
              handle: state.handle,
            })
            .catch((error) => report("close", error));
        },
      };
    },
  };
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  // Tolerate a Node Buffer shape if a transport ever serializes it as
  // `{ type: "Buffer", data: number[] }`; the digest check still gates use.
  if (value !== null && typeof value === "object") {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  }
  throw new Error("The verified artifact bytes were not recognized");
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Load one artifact ref through the native verified fetcher and re-verify it
 * locally before exposing a blob URL. The native side bounds the response to
 * the loader's single-file limit and re-checks the business generation before
 * returning.
 */
export async function loadWebsiteArtifact(
  ref: WebsiteArtifactRefLike,
  communityId: string,
  signal?: AbortSignal,
): Promise<WebsiteLoadedArtifact> {
  const api = electronDesktop();
  if (!api) throw new Error("The verified artifact loader is not available");
  if (isAborted(signal)) throw abortError();
  const result = await api.request<{
    bytes: unknown;
    contentType: string | null;
  }>("website-artifact:load", { communityId, manifest: { ...ref } });
  if (isAborted(signal)) throw abortError();
  const bytes = toUint8Array(result.bytes);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const verifiedSha256 = toHex(new Uint8Array(digest));
  if (verifiedSha256 !== ref.sha256) {
    throw new Error("The artifact failed local verification");
  }
  const objectUrl = URL.createObjectURL(
    new Blob([bytes], {
      type: result.contentType ?? "application/octet-stream",
    }),
  );
  return {
    objectUrl,
    verifiedSha256,
    revoke: () => URL.revokeObjectURL(objectUrl),
  };
}

/**
 * Bind the artifact loader to one community. The result satisfies the
 * feature `WebsiteArtifactLoader` shape (`load(artifact, signal)`).
 */
export function createWebsiteArtifactLoader(
  communityId: string,
): WebsiteArtifactLoaderLike {
  return {
    load: (ref, signal) => loadWebsiteArtifact(ref, communityId, signal),
  };
}

/**
 * Download approved handover assets to a user-chosen directory. The native
 * side re-verifies every digest into private staging, checks the business
 * generation before finalizing, writes only literal relative paths, never
 * overwrites an existing file, and returns recoverable per-item outcomes.
 */
export async function downloadWebsiteHandover(
  items: readonly WebsiteHandoverItem[],
  communityId: string,
): Promise<WebsiteHandoverResult> {
  const api = electronDesktop();
  if (!api) throw new Error("The handover download is not available");
  return api.request<WebsiteHandoverResult>("website-handover:download", {
    communityId,
    items: items.map((item) => ({ ...item })),
  });
}
