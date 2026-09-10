/**
 * Pure viewport math for the native preview view.
 *
 * The host keeps the page's real CSS viewport at the site's native size
 * (1440x900 desktop, 390x844 mobile) no matter how small the inline pane is.
 * That is done deliberately: the native view is sized in device-independent
 * pixels and `webContents.setZoomFactor` is derived from the fitted width, so
 * CSS pixels scale instead of the CSS viewport shrinking. Media queries and
 * `window.innerWidth` therefore keep native semantics while the view fits the
 * pane without cropping.
 */

import { PreviewHostError } from "./host-errors.mjs";

/** Exact native CSS viewports the preview must preserve. Mirrors the UI. */
export const PREVIEW_PIXEL_SIZES = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900 }),
  mobile: Object.freeze({ width: 390, height: 844 }),
});

/** Upper bound for one native CSS viewport edge, in CSS pixels. */
export const PREVIEW_MAX_PIXEL_EDGE = 8192;

const VIEWPORTS = new Set(Object.keys(PREVIEW_PIXEL_SIZES));
const HIDDEN_LAYOUT = Object.freeze({ visible: false });
// Sub-pixel slack so a rect that is fully inside the clip is not hidden by
// floating-point multiplication of the application zoom factor.
const CONTAINMENT_EPSILON = 0.01;

function invalid(code, message, details) {
  return new PreviewHostError(code, message, details);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate the preview viewport name. */
export function resolveViewport(value) {
  if (typeof value !== "string" || !VIEWPORTS.has(value)) {
    throw invalid(
      "invalid_viewport",
      `viewport must be one of ${[...VIEWPORTS].join(", ")}`,
    );
  }
  return value;
}

/** Resolve and validate the exact native CSS size for one viewport. */
export function resolvePixelSize(viewport, width, height) {
  const fallback = PREVIEW_PIXEL_SIZES[viewport];
  const resolvedWidth = width === undefined ? fallback.width : width;
  const resolvedHeight = height === undefined ? fallback.height : height;
  for (const [label, value] of [
    ["pixelWidth", resolvedWidth],
    ["pixelHeight", resolvedHeight],
  ]) {
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > PREVIEW_MAX_PIXEL_EDGE
    ) {
      throw invalid(
        "invalid_viewport",
        `${label} must be an integer between 1 and ${PREVIEW_MAX_PIXEL_EDGE}`,
      );
    }
  }
  return { width: resolvedWidth, height: resolvedHeight };
}

/**
 * Validate the application zoom factor used to convert caller CSS pixels to
 * window content (device-independent) pixels. The host resolves this from the
 * owning window's `webContents.getZoomFactor()` when the caller omits it.
 */
export function validateZoom(value) {
  if (!isFiniteNumber(value) || value <= 0 || value > 16) {
    throw invalid(
      "invalid_zoom",
      "zoom must be a positive finite number at most 16",
    );
  }
  return value;
}

/** Validate and freeze a caller rectangle in CSS pixels. */
export function normalizeRect(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("invalid_bounds", "bounds must be a rectangle");
  }
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(isFiniteNumber) || width < 0 || height < 0) {
    throw invalid(
      "invalid_bounds",
      "bounds must have finite x, y, width, and height",
    );
  }
  return Object.freeze({ x, y, width, height });
}

/**
 * Validate and freeze the visible app-window clip, or `null`.
 *
 * The clip uses `{top, left, right, bottom}` in the same CSS pixel space as
 * the bounds. It models fixed headers, the composer, and any other DOM the
 * native view must never cover.
 */
export function normalizeClip(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalid("invalid_clip", "clip must be {top, left, right, bottom}");
  }
  const { top, left, right, bottom } = value;
  if (![top, left, right, bottom].every(isFiniteNumber)) {
    throw invalid("invalid_clip", "clip edges must be finite numbers");
  }
  return Object.freeze({ top, left, right, bottom });
}

function intersect(rect, clip) {
  const left = Math.max(rect.x, clip.left);
  const top = Math.max(rect.y, clip.top);
  const right = Math.min(rect.x + rect.width, clip.right);
  const bottom = Math.min(rect.y + rect.height, clip.bottom);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function contains(outer, inner) {
  return (
    inner.x <= outer.x + CONTAINMENT_EPSILON &&
    inner.y <= outer.y + CONTAINMENT_EPSILON &&
    inner.x + inner.width >= outer.x + outer.width - CONTAINMENT_EPSILON &&
    inner.y + inner.height >= outer.y + outer.height - CONTAINMENT_EPSILON
  );
}

/**
 * Compute native view bounds for one update.
 *
 * `bounds` is the full, unclipped element rectangle, so the fit scale is
 * derived once and stays stable while the pane scrolls. `clip` selects the
 * visible part. `clipStrategy: "clip"` (default) maps the visible part to the
 * container view, which clips the child, and `clipStrategy: "hide"` hides the
 * view whenever the visible part is not the whole element (the fallback for a
 * platform where container clipping is not proven).
 *
 * Returns `{ visible: false }` when there is no paintable intersection, or
 * `{ visible: true, container, child, zoomFactor, cssWidth, cssHeight }`.
 */
export function computePreviewLayout(input) {
  const {
    bounds,
    clip = null,
    zoom = 1,
    pixelWidth,
    pixelHeight,
    clipStrategy = "clip",
  } = input;
  if (clipStrategy !== "clip" && clipStrategy !== "hide") {
    throw invalid("invalid_strategy", "clipStrategy must be clip or hide");
  }
  for (const [label, value] of [
    ["pixelWidth", pixelWidth],
    ["pixelHeight", pixelHeight],
  ]) {
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > PREVIEW_MAX_PIXEL_EDGE
    ) {
      throw invalid(
        "invalid_layout",
        `${label} must be a positive integer at most ${PREVIEW_MAX_PIXEL_EDGE}`,
      );
    }
  }
  if (!isFiniteNumber(zoom)) {
    throw invalid("invalid_layout", "zoom must be a finite number");
  }
  const rect = normalizeRect(bounds);
  const factor = validateZoom(zoom);
  const full = {
    x: rect.x * factor,
    y: rect.y * factor,
    width: rect.width * factor,
    height: rect.height * factor,
  };
  const clipRect =
    clip === null
      ? null
      : {
          top: clip.top * factor,
          left: clip.left * factor,
          right: clip.right * factor,
          bottom: clip.bottom * factor,
        };
  const visible = clipRect === null ? full : intersect(full, clipRect);
  if (visible === null || visible.width < 1 || visible.height < 1) {
    return HIDDEN_LAYOUT;
  }
  if (clipStrategy === "hide" && !contains(full, visible)) {
    return HIDDEN_LAYOUT;
  }

  // The fit uses the full element pane, never the clipped slice, so clipping
  // during scroll cannot change the page scale.
  const scale = Math.min(1, full.width / pixelWidth, full.height / pixelHeight);
  const viewWidth = Math.max(1, Math.round(pixelWidth * scale));
  const viewHeight = Math.max(1, Math.round(pixelHeight * scale));
  const offsetX = Math.round((full.width - viewWidth) / 2);
  const offsetY = Math.round((full.height - viewHeight) / 2);
  return Object.freeze({
    visible: true,
    container: Object.freeze({
      x: Math.round(visible.x),
      y: Math.round(visible.y),
      width: Math.max(1, Math.round(visible.width)),
      height: Math.max(1, Math.round(visible.height)),
    }),
    child: Object.freeze({
      x: Math.round(full.x - visible.x + offsetX),
      y: Math.round(full.y - visible.y + offsetY),
      width: viewWidth,
      height: viewHeight,
    }),
    // Derived from the actual fitted width, not from the ideal scale, so the
    // CSS viewport is the native width even after integer rounding.
    zoomFactor: viewWidth / pixelWidth,
    cssWidth: pixelWidth,
    cssHeight: pixelHeight,
  });
}
