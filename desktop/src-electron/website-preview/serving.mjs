/**
 * Request resolution for one mounted preview.
 *
 * Pure functions over a mounted entry: no Electron objects, no ambient state,
 * so the same rules run in source tests. Navigation authorization and request
 * serving share `parsePreviewUrl`, and only bytes returned by the verified
 * loader's `getFile` are ever served, only for the entry's own random token
 * and exact listed key, or for the separate generated wrapper token and its
 * one fixed route.
 *
 * Inline script authorization is computed per served HTML document, not only
 * for the entrypoint: a verified second page with its own inline menu or tab
 * script gets its own hash-authorized CSP. The never-serving path stays
 * `'self'` plus verified content hashes; there is no sanitizer here.
 */

import { collectInlineAuthorizations } from "./inline-script.mjs";
import {
  PREVIEW_CSP,
  PREVIEW_WRAPPER_PATH,
  parsePreviewUrl,
  previewCsp,
  previewEntryUrl,
  previewHeaders,
  previewMissHeaders,
  previewOrigin,
} from "./scheme.mjs";

/** Stable DOM id shared by the generated wrapper and its layout updater. */
export const PREVIEW_WRAPPER_FRAME_ID = "colony-preview-child";

function refused(status, message) {
  return new Response(message, {
    status,
    headers: previewMissHeaders(),
  });
}

/**
 * True only for the wrapper's one main-frame route or a listed artifact file
 * in the child frame. Both navigation and serving call this exact parser.
 */
export function isAllowedEntryUrl(entry, rawUrl, { isMainFrame = true } = {}) {
  if (entry.disposed || entry.site === null || entry.paths === null) {
    return false;
  }
  const parsed = parsePreviewUrl(rawUrl);
  if (parsed === null) return false;
  if (entry.wrapperToken !== null && entry.wrapperToken !== undefined) {
    if (isMainFrame) {
      return (
        parsed.token === entry.wrapperToken &&
        parsed.path === (entry.wrapperPath ?? PREVIEW_WRAPPER_PATH)
      );
    }
    if (parsed.token !== entry.token) return false;
  } else if (parsed.token !== entry.token) {
    return false;
  }
  return servedPath(entry, parsed.path) !== null;
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
}

function wrapperLayoutValues(layout) {
  const zoom =
    layout?.visible === true &&
    typeof layout.zoomFactor === "number" &&
    Number.isFinite(layout.zoomFactor) &&
    layout.zoomFactor > 0
      ? layout.zoomFactor
      : 1;
  const child = layout?.visible === true ? layout.child : null;
  return {
    left: child === null ? 0 : child.x / zoom,
    top: child === null ? 0 : child.y / zoom,
  };
}

/** Generate the trusted wrapper document around one verified artifact. */
export function previewWrapperDocument({
  artifactToken,
  entrypoint,
  pixelWidth,
  pixelHeight,
  layout,
}) {
  const { left, top } = wrapperLayoutValues(layout);
  const source = previewEntryUrl(artifactToken, entrypoint);
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    "html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}" +
    `#${PREVIEW_WRAPPER_FRAME_ID}{position:absolute;display:block;box-sizing:border-box;` +
    `border:0;width:${pixelWidth}px;height:${pixelHeight}px;left:${left}px;top:${top}px}` +
    "</style></head><body>" +
    `<iframe id="${PREVIEW_WRAPPER_FRAME_ID}" title="Website preview" ` +
    `sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" ` +
    `src="${escapeAttribute(source)}"></iframe>` +
    "</body></html>"
  );
}

function servedPath(entry, path) {
  const resolved = path === "" ? entry.site.entrypoint : path;
  return entry.paths.has(resolved) ? resolved : null;
}

/**
 * CSP for one served file.
 *
 * `resolved` is the canonical listed path (`""` was already mapped to the
 * entrypoint), so the origin root and the explicit entrypoint share one cache
 * entry and one truncation push. Every `text/html` response is authorized
 * from its own verified bytes; non-HTML responses get the base CSP with no
 * inline authorizations at all. Truncation flips once per entry and pushes
 * exactly one scoped state update through `entry.onInlineTruncated`.
 */
function cspForFile(entry, resolved, file) {
  if (file.mime !== "text/html") return PREVIEW_CSP;
  if (entry.cspByPath === null || entry.cspByPath === undefined) {
    entry.cspByPath = new Map();
  }
  const cached = entry.cspByPath.get(resolved);
  if (cached !== undefined) return cached;
  const authorizations = collectInlineAuthorizations(file.bytes);
  const csp = previewCsp({
    ...authorizations,
    frameAncestors:
      entry.wrapperToken === null || entry.wrapperToken === undefined
        ? undefined
        : previewOrigin(entry.wrapperToken),
  });
  entry.cspByPath.set(resolved, csp);
  if (authorizations.truncated && entry.inlineScriptsTruncated !== true) {
    entry.inlineScriptsTruncated = true;
    try {
      entry.onInlineTruncated?.();
    } catch {
      // A state consumer must never break a response.
    }
  }
  return csp;
}

/** Serve one partition-scoped protocol request, or a closed refusal. */
export function servePreviewRequest(entry, request) {
  if (entry.disposed || entry.site === null) {
    return refused(404, "Not found");
  }
  const method =
    typeof request?.method === "string" ? request.method.toUpperCase() : "GET";
  if (method !== "GET") {
    return refused(405, "Method not allowed");
  }
  const parsed = parsePreviewUrl(request?.url);
  if (parsed === null) return refused(404, "Not found");
  if (
    entry.wrapperToken !== null &&
    entry.wrapperToken !== undefined &&
    parsed.token === entry.wrapperToken &&
    parsed.path === (entry.wrapperPath ?? PREVIEW_WRAPPER_PATH)
  ) {
    const artifactOrigin = previewOrigin(entry.token);
    const body = Buffer.from(
      previewWrapperDocument({
        artifactToken: entry.token,
        entrypoint: entry.site.entrypoint,
        pixelWidth: entry.pixelWidth,
        pixelHeight: entry.pixelHeight,
        layout: entry.wrapperLayout,
      }),
      "utf8",
    );
    return new Response(body, {
      status: 200,
      headers: previewHeaders("text/html", {
        csp: previewCsp({
          frameSrc: artifactOrigin,
          childSrc: artifactOrigin,
        }),
      }),
    });
  }
  if (parsed.token !== entry.token) return refused(404, "Not found");
  const resolved = servedPath(entry, parsed.path);
  if (resolved === null) return refused(404, "Not found");
  const file = entry.site.getFile(resolved);
  if (
    file === null ||
    !Buffer.isBuffer(file.bytes) ||
    typeof file.mime !== "string"
  ) {
    return refused(404, "Not found");
  }
  return new Response(file.bytes, {
    status: 200,
    headers: previewHeaders(file.mime, {
      csp: cspForFile(entry, resolved, file),
      // The artifact document is loaded cross-origin by the trusted wrapper;
      // its exact frame-ancestors CSP still prevents any other embedder.
      crossOriginResourcePolicy:
        entry.wrapperToken !== null && entry.wrapperToken !== undefined
          ? "cross-origin"
          : "same-origin",
    }),
  });
}
