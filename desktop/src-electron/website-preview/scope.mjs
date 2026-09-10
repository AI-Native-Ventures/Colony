/**
 * Scope validation for the preview host.
 *
 * The preview identity is exact: owner window, community, job, thread root,
 * revision, and manifest hash. Every field is validated before any network or
 * renderer work, so a malformed scope fails closed and never reaches the
 * loader or a native view.
 */

import { PreviewHostError } from "./host-errors.mjs";
import {
  PREVIEW_PIXEL_SIZES,
  normalizeClip,
  normalizeRect,
  resolvePixelSize,
  resolveViewport,
  validateZoom,
} from "./viewport.mjs";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_RADIUS = 1024;

let windowSequence = 0;
const windowTokens = new WeakMap();

function invalid(code, message, details) {
  return new PreviewHostError(code, message, details);
}

/** Validate a bounded community or job identifier. */
export function requireId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw invalid(
      "invalid_scope",
      `${label} must be 1 to 128 letters, digits, dots, underscores, or dashes`,
    );
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw invalid(
      "invalid_scope",
      `${label} must be 64 lowercase hex characters`,
    );
  }
  return value;
}

function requireManifest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("invalid_scope", "manifest must be an artifact ref");
  }
  const { url, sha256 } = value;
  if (typeof url !== "string" || url === "") {
    throw invalid("invalid_scope", "manifest.url must be a string");
  }
  return Object.freeze({
    url,
    sha256: requireSha256(sha256, "manifest.sha256"),
  });
}

function assertWindow(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    !value.contentView ||
    typeof value.contentView.addChildView !== "function" ||
    typeof value.contentView.removeChildView !== "function" ||
    typeof value.once !== "function"
  ) {
    throw invalid("invalid_window", "an owning BrowserWindow is required");
  }
  return value;
}

function assertSignal(value) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "object" ||
    typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function" ||
    typeof value.removeEventListener !== "function"
  ) {
    throw invalid("invalid_signal", "signal must be an AbortSignal");
  }
  return value;
}

/** Validate an optional cosmetic corner radius. */
export function normalizeRadius(value) {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_RADIUS
  ) {
    throw invalid(
      "invalid_radius",
      `radius must be between 0 and ${MAX_RADIUS}`,
    );
  }
  return value;
}

/**
 * Resolve the application zoom used to convert caller CSS pixels to window
 * content pixels. Callers may pass an explicit factor; otherwise it is read
 * from the owning window so a zoomed app still aligns the native view.
 */
export function resolveZoom(window, value) {
  if (value !== undefined && value !== null) return validateZoom(value);
  const fromWindow =
    typeof window?.webContents?.getZoomFactor === "function"
      ? window.webContents.getZoomFactor()
      : 1;
  return validateZoom(
    Number.isFinite(fromWindow) && fromWindow > 0 ? fromWindow : 1,
  );
}

function windowKey(window) {
  let key = windowTokens.get(window);
  if (key === undefined) {
    windowSequence += 1;
    key = `w${windowSequence}`;
    windowTokens.set(window, key);
  }
  return key;
}

/** Validate and normalize one full `open` request. */
export function validateOpenRequest(request) {
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request)
  ) {
    throw invalid("invalid_request", "open requires a request object");
  }
  const window = assertWindow(request.window);
  const communityId = requireId(request.communityId, "communityId");
  const jobId = requireId(request.jobId, "jobId");
  const threadRoot = requireSha256(request.threadRoot, "threadRoot");
  if (!Number.isSafeInteger(request.revision) || request.revision < 1) {
    throw invalid("invalid_scope", "revision must be a positive integer");
  }
  const viewport = resolveViewport(request.viewport);
  const size = resolvePixelSize(
    viewport,
    request.pixelWidth,
    request.pixelHeight,
  );
  const canonical = PREVIEW_PIXEL_SIZES[viewport];
  if (size.width !== canonical.width || size.height !== canonical.height) {
    throw invalid(
      "invalid_viewport",
      `a ${viewport} preview renders at exactly ${canonical.width}x${canonical.height}`,
    );
  }
  const manifest = requireManifest(request.manifest);
  if (request.zoom !== undefined) validateZoom(request.zoom);
  const bounds =
    request.bounds === undefined || request.bounds === null
      ? null
      : normalizeRect(request.bounds);
  const clip =
    request.clip === undefined || request.clip === null
      ? null
      : normalizeClip(request.clip);
  return {
    window,
    communityId,
    jobId,
    threadRoot,
    revision: request.revision,
    manifest,
    viewport,
    pixelWidth: size.width,
    pixelHeight: size.height,
    bounds,
    clip,
    zoom: request.zoom,
    radius: normalizeRadius(request.radius),
    visible:
      request.visible === undefined
        ? bounds !== null
        : request.visible === true,
    signal: assertSignal(request.signal),
  };
}

/** Stable identity for one preview scope. */
export function scopeKey(scope) {
  return [
    windowKey(scope.window),
    scope.communityId,
    scope.jobId,
    scope.threadRoot,
    String(scope.revision),
    scope.manifest.sha256,
    scope.viewport,
  ].join(":");
}

/** Map loader and abort failures onto host error codes. */
export function normalizeOpenError(entry, error) {
  if (entry.disposed) {
    return invalid("preview_closed", "preview was closed before it opened");
  }
  if (error instanceof PreviewHostError) return error;
  const code =
    typeof error?.code === "string" ? error.code : "preview_load_failed";
  const normalized = invalid(
    code === "aborted" ? "preview_aborted" : code,
    typeof error?.message === "string" ? error.message : "preview load failed",
  );
  normalized.cause = error;
  return normalized;
}
