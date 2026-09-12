/**
 * Native view lifecycle for the preview host: mount, security handlers,
 * ordered detach, and teardown.
 *
 * Every function but `mountEntry` takes only the entry record, so the mount
 * side (Electron constructors) stays in `host.mjs` and the teardown side can
 * be exercised in source tests.
 */

import { randomBytes } from "node:crypto";

import { PreviewHostError } from "./host-errors.mjs";
import {
  PREVIEW_SCHEME,
  PREVIEW_WRAPPER_PATH,
  parsePreviewUrl,
  previewEntryUrl,
  previewOrigin,
} from "./scheme.mjs";
import { isAllowedEntryUrl, servePreviewRequest } from "./serving.mjs";

/** Cap on the first main-frame load before the view is reported failed. */
export const PREVIEW_FIRST_LOAD_TIMEOUT_MS = 30_000;

function invalid(code, message, details) {
  return new PreviewHostError(code, message, details);
}

function windowDestroyed(window) {
  try {
    return typeof window.isDestroyed === "function" && window.isDestroyed();
  } catch {
    return true;
  }
}

/** Deny permissions and downloads and confine traffic to the preview origin. */
export function configurePreviewSession(entry, previewSession) {
  previewSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  previewSession.setPermissionCheckHandler(() => false);
  const onDownload = (event, item) => {
    event.preventDefault();
    try {
      item?.cancel?.();
    } catch {
      // Download cancellation must not mask teardown.
    }
  };
  previewSession.on("will-download", onDownload);
  entry.sessionListeners.push(["will-download", onDownload]);

  const allowedPrefixes = [entry.token, entry.wrapperToken]
    .filter((token) => typeof token === "string" && token !== "")
    .map((token) => `${previewOrigin(token)}/`);
  const onBeforeRequest = (details, callback) => {
    const url = typeof details?.url === "string" ? details.url : "";
    callback({
      cancel: !allowedPrefixes.some((prefix) => url.startsWith(prefix)),
    });
  };
  previewSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    onBeforeRequest,
  );
  entry.clearWebRequest = () => {
    try {
      previewSession.webRequest.onBeforeRequest(null);
    } catch {
      // The session may already be gone during shutdown.
    }
  };
  previewSession.protocol.handle(PREVIEW_SCHEME, (request) =>
    servePreviewRequest(entry, request),
  );
  entry.protocolHandled = true;
}

/**
 * Deny popups, subframes, webviews, downloads, and any navigation that is not
 * the generated wrapper on its own origin or a listed file in the verified
 * artifact child frame.
 *
 * `onLayout` re-applies geometry after a load event and `onState` pushes a
 * scoped state update after a failure, so a stopped renderer is reported to
 * the renderer instead of being a silent blank view.
 */
export function configurePreviewWebContents(entry, onLayout, onState) {
  const webContents = entry.webContents;
  const on = (event, handler) => {
    webContents.on(event, handler);
    entry.webContentsListeners.push([event, handler]);
  };
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  on("will-navigate", (event, url) => {
    if (!isAllowedEntryUrl(entry, url, { isMainFrame: true })) {
      event.preventDefault();
    }
  });
  on("will-redirect", (event, url, ...rest) => {
    const booleans = rest.filter((value) => typeof value === "boolean");
    const isMainFrame = booleans.length === 0 ? true : booleans.at(-1);
    if (!isAllowedEntryUrl(entry, url, { isMainFrame })) {
      event.preventDefault();
    }
  });
  on("will-frame-navigate", (event, details) => {
    const navigation = details ?? event;
    const url =
      typeof navigation?.url === "string"
        ? navigation.url
        : typeof event?.url === "string"
          ? event.url
          : "";
    const isMainFrame =
      typeof navigation?.isMainFrame === "boolean"
        ? navigation.isMainFrame
        : typeof event?.isMainFrame === "boolean"
          ? event.isMainFrame
          : true;
    if (!isAllowedEntryUrl(entry, url, { isMainFrame })) {
      event.preventDefault();
    }
  });
  on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  on("did-finish-load", () => {
    onLayout();
  });
  on("did-frame-finish-load", () => {
    onLayout();
  });
  on("did-navigate", () => {
    onLayout();
  });
  on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame !== true || code === -3) return;
    entry.failed = true;
    entry.lastError =
      typeof description === "string" ? description : "load_failed";
    onLayout();
    onState();
  });
  on("render-process-gone", () => {
    entry.failed = true;
    entry.lastError = "renderer_gone";
    onLayout();
    onState();
  });
}

function isArtifactEntrypointUrl(entry, rawUrl) {
  if (entry.site === null || entry.paths === null) return false;
  const parsed = parsePreviewUrl(rawUrl);
  if (parsed === null || parsed.token !== entry.token) return false;
  const path = parsed.path === "" ? entry.site.entrypoint : parsed.path;
  return (
    path === entry.site.entrypoint &&
    isAllowedEntryUrl(entry, rawUrl, { isMainFrame: false })
  );
}

function frameIdentity(frame) {
  return {
    processId: frame?.processId ?? frame?.frameProcessId,
    routingId: frame?.routingId ?? frame?.frameRoutingId,
  };
}

/** True only when the finished frame identity names the intended child. */
export function isFinishedArtifactEntrypointFrame(entry, details = {}) {
  if (details.isMainFrame === true) return false;
  if (!Number.isInteger(details.frameProcessId)) return false;
  if (!Number.isInteger(details.frameRoutingId)) return false;
  try {
    const frames = entry.webContents?.mainFrame?.frames;
    return (
      Array.isArray(frames) &&
      frames.some((frame) => {
        const identity = frameIdentity(frame);
        return (
          identity.processId === details.frameProcessId &&
          identity.routingId === details.frameRoutingId &&
          isArtifactEntrypointUrl(entry, frame?.url)
        );
      })
    );
  } catch {
    return false;
  }
}

function frameEventDetails(args) {
  const event = args[0];
  const details = args.find(
    (value, index) => index > 0 && value !== null && typeof value === "object",
  );
  const isMainFrame =
    typeof event?.isMainFrame === "boolean"
      ? event.isMainFrame
      : typeof details?.isMainFrame === "boolean"
        ? details.isMainFrame
        : typeof args[1] === "boolean"
          ? args[1]
          : undefined;
  const frameProcessId =
    details?.frameProcessId ??
    details?.processId ??
    (Number.isInteger(args[2]) ? args[2] : undefined);
  const frameRoutingId =
    details?.frameRoutingId ??
    details?.routingId ??
    (Number.isInteger(args[3]) ? args[3] : undefined);
  return { isMainFrame, frameProcessId, frameRoutingId };
}

/**
 * Wait for the first entrypoint load to finish, fail, abort, or time out.
 *
 * This is the real readiness gate: `open` does not resolve `ready` until this
 * settles, so a blank or failed first paint can never be labelled
 * interactive.
 */
function waitForFirstLoad(entry) {
  const webContents = entry.webContents;
  let fail = () => {};
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let onAbort = () => {};
    const listeners = [];
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      for (const [event, handler] of listeners) {
        webContents.removeListener?.(event, handler);
      }
      entry.controller.signal.removeEventListener("abort", onAbort);
      if (error === null) resolve();
      else reject(error);
    };
    fail = (error) => settle(error);
    onAbort = () =>
      settle(invalid("preview_closed", "preview was closed before it loaded"));
    const on = (event, handler) => {
      webContents.on(event, handler);
      entry.webContentsListeners.push([event, handler]);
      listeners.push([event, handler]);
    };
    on("did-finish-load", () => {
      if (entry.wrapperEnabled !== true) {
        settle(null);
      }
    });
    on("did-frame-finish-load", (...args) => {
      if (!entry.wrapperEnabled) return;
      if (isFinishedArtifactEntrypointFrame(entry, frameEventDetails(args))) {
        settle(null);
      }
    });
    on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (code === -3) return;
      if (
        entry.wrapperEnabled === true &&
        isMainFrame !== true &&
        isArtifactEntrypointUrl(entry, url)
      ) {
        settle(
          invalid(
            "preview_load_failed",
            typeof description === "string" && description !== ""
              ? description
              : "the preview entrypoint failed to load",
          ),
        );
        return;
      }
      if (isMainFrame !== true) return;
      settle(
        invalid(
          "preview_load_failed",
          typeof description === "string" && description !== ""
            ? description
            : "the preview entrypoint failed to load",
        ),
      );
    });
    on("render-process-gone", () =>
      settle(invalid("preview_renderer_gone", "the preview renderer stopped")),
    );
    if (entry.controller.signal.aborted) {
      onAbort();
      return;
    }
    entry.controller.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () =>
        settle(
          invalid(
            "preview_load_timeout",
            "the preview entrypoint did not finish loading",
          ),
        ),
      PREVIEW_FIRST_LOAD_TIMEOUT_MS,
    );
  });
  return { promise, fail };
}

/** Apply the caller's radius to the container when one was requested. */
export function applyEntryBorderRadius(entry) {
  if (
    entry.radius !== undefined &&
    typeof entry.container?.setBorderRadius === "function"
  ) {
    try {
      entry.container.setBorderRadius(entry.radius);
    } catch {
      // Border radius is cosmetic and must never break an update.
    }
  }
}

/** Create the isolated session, container, and view, then wait for load. */
export async function mountEntry(host, entry) {
  if (windowDestroyed(entry.window)) {
    throw invalid("window_closed", "the owning window is gone");
  }
  const token = randomBytes(16).toString("hex");
  const wrapperEnabled = host.clipStrategy === "clip";
  const partition = `preview-${token}`;
  const previewSession = host.session.fromPartition(partition);
  if (
    previewSession === null ||
    typeof previewSession !== "object" ||
    typeof previewSession.protocol?.handle !== "function"
  ) {
    throw invalid(
      "session_failed",
      "could not create an isolated preview session",
    );
  }
  entry.token = token;
  entry.wrapperEnabled = wrapperEnabled;
  entry.wrapperToken = wrapperEnabled ? randomBytes(16).toString("hex") : null;
  entry.wrapperPath = wrapperEnabled ? PREVIEW_WRAPPER_PATH : null;
  entry.partition = partition;
  entry.previewSession = previewSession;
  configurePreviewSession(entry, previewSession);

  // Compute the fitted factor before construction so the first paint is
  // already scaled; applyLayout re-applies it after every load.
  const initialLayout = host.layoutFor(entry);

  const container = new host.View();
  const view = new host.WebContentsView({
    webPreferences: {
      session: previewSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      disableDialogs: true,
      spellcheck: false,
      zoomFactor: initialLayout.visible === true ? initialLayout.zoomFactor : 1,
    },
  });
  if (
    !view.webContents ||
    typeof view.webContents.setWindowOpenHandler !== "function"
  ) {
    throw invalid("view_failed", "could not create the preview web contents");
  }
  entry.container = container;
  entry.view = view;
  entry.webContents = view.webContents;
  configurePreviewWebContents(
    entry,
    () => host.applyLayout(entry),
    () => host.emitState(entry),
  );
  entry.window.contentView.addChildView(container);
  container.addChildView(view);
  try {
    container.setVisible(false);
    view.setVisible(false);
  } catch {
    // A hidden view is best-effort here; layout decides final visibility.
  }
  applyEntryBorderRadius(entry);
  host.applyLayout(entry);
  const load = waitForFirstLoad(entry);
  try {
    const initialUrl = wrapperEnabled
      ? previewEntryUrl(entry.wrapperToken, entry.wrapperPath)
      : previewEntryUrl(token, entry.site.entrypoint);
    await view.webContents.loadURL(initialUrl);
  } catch (error) {
    load.fail(
      invalid(
        "preview_load_failed",
        error instanceof Error && error.message !== ""
          ? error.message
          : "the preview entrypoint could not be loaded",
      ),
    );
  }
  await load.promise;
}

/**
 * Synchronous detach. Runs before any await so a business switch cannot be
 * raced by a view that is still mounting.
 */
export function detachEntry(entry) {
  try {
    entry.view?.setVisible(false);
  } catch {
    // Best-effort immediate hiding; the view is detached next.
  }
  try {
    entry.container?.setVisible(false);
  } catch {
    // Best-effort immediate hiding; the view is detached next.
  }
  if (
    entry.container !== null &&
    entry.window !== null &&
    !windowDestroyed(entry.window)
  ) {
    try {
      entry.window.contentView.removeChildView(entry.container);
    } catch {
      // The window content view may already be gone.
    }
  }
  try {
    entry.container?.removeChildView?.(entry.view);
  } catch {
    // The container may already be gone.
  }
}

/** Ordered async teardown: listeners, web contents, session, storage, cache. */
export async function destroyEntry(entry) {
  const webContents = entry.webContents;
  if (webContents !== null) {
    for (const [event, handler] of entry.webContentsListeners) {
      try {
        webContents.removeListener?.(event, handler);
      } catch {
        // Listener removal must not stop the rest of teardown.
      }
    }
    entry.webContentsListeners = [];
    try {
      webContents.close?.({ waitForBeforeUnload: false });
    } catch {
      // The web contents may already be destroyed.
    }
  }
  const previewSession = entry.previewSession;
  if (previewSession !== null) {
    for (const [event, handler] of entry.sessionListeners) {
      try {
        previewSession.removeListener?.(event, handler);
      } catch {
        // Listener removal must not stop the rest of teardown.
      }
    }
    entry.sessionListeners = [];
    try {
      entry.clearWebRequest?.();
    } catch {
      // The session may already be gone.
    }
    entry.clearWebRequest = null;
    if (entry.protocolHandled) {
      try {
        previewSession.protocol?.unhandle?.(PREVIEW_SCHEME);
      } catch {
        // Unregistering an already-gone handler is fine.
      }
      entry.protocolHandled = false;
    }
    try {
      await previewSession.clearStorageData?.();
    } catch {
      // Ephemeral storage dies with the session regardless.
    }
    try {
      await previewSession.clearCache?.();
    } catch {
      // Ephemeral cache dies with the session regardless.
    }
  }
  entry.site = null;
  entry.paths = null;
  entry.wrapperEnabled = false;
  entry.wrapperToken = null;
  entry.wrapperPath = null;
  entry.wrapperLayout = null;
  entry.webContents = null;
  entry.view = null;
  entry.container = null;
  entry.loadedBytes = null;
  entry.reservedBytes = 0;
}
