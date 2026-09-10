/**
 * Scheme, URL, path, and response rules for the isolated preview host.
 *
 * The scheme is registered once, before `app.whenReady()`, by appending
 * `PREVIEW_SCHEME_DESCRIPTOR` to the application's single
 * `protocol.registerSchemesAsPrivileged([...])` call. Nothing here touches
 * `protocol` directly: the host registers a handler on the preview's own
 * ephemeral session (`session.protocol.handle`), so the handler and the files
 * it serves can never leak into the application session.
 */

/** Custom scheme reserved for verified website preview artifacts. */
export const PREVIEW_SCHEME = "colony-preview";

/**
 * Privileges handed to `registerSchemesAsPrivileged` for the preview scheme.
 *
 * `standard` gives URL semantics (origin, relative resolution, hash anchors),
 * `secure` keeps the preview a secure context, `supportFetchAPI` lets verified
 * same-origin JSON load, and `corsEnabled: false` plus
 * `allowServiceWorkers: false` keep the origin closed: no cross-origin reads
 * and no background worker that could outlive the view.
 */
export const PREVIEW_SCHEME_DESCRIPTOR = Object.freeze({
  scheme: PREVIEW_SCHEME,
  privileges: Object.freeze({
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: false,
    allowServiceWorkers: false,
  }),
});

const TEXTUAL_MIMES = new Set([
  "text/html",
  "text/css",
  "text/plain",
  "text/javascript",
  "application/javascript",
  "application/json",
  "application/manifest+json",
  "image/svg+xml",
]);

/**
 * Restrictive CSP directives served with every preview response.
 *
 * Only verified same-origin files may load. External images, fonts, media,
 * frames, objects, workers, connections, and form posts are all refused.
 * Inline styles are allowed because they do not execute. Inline scripts are
 * authorized only by the SHA-256 hashes of each verified HTML document's own
 * bytes (`previewCsp`), never by `'unsafe-inline'`, and `wasm-unsafe-eval`
 * keeps allowlisted `application/wasm` files usable without opening eval.
 */
export const PREVIEW_CSP_DIRECTIVES = Object.freeze([
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self'",
  "manifest-src 'self'",
  "connect-src 'self'",
  "worker-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
]);

/**
 * Build the response CSP, authorizing only the supplied hash tokens.
 *
 * `scriptHashes` and `handlerHashes` are pre-formatted CSP source expressions
 * (`'sha256-...'`) computed from one verified HTML document's bytes. Inline
 * event handler attributes additionally require `'unsafe-hashes'`, so that
 * token is added only when handler hashes exist. There is no code path that
 * adds `'unsafe-inline'` to `script-src`.
 */
export function previewCsp({ scriptHashes = [], handlerHashes = [] } = {}) {
  return PREVIEW_CSP_DIRECTIVES.map((directive) => {
    if (!directive.startsWith("script-src")) return directive;
    const tokens = [...scriptHashes];
    if (handlerHashes.length > 0) {
      tokens.push("'unsafe-hashes'", ...handlerHashes);
    }
    return tokens.length === 0 ? directive : `${directive} ${tokens.join(" ")}`;
  }).join("; ");
}

/** The no-hash CSP (documents that authorize no inline script at all). */
export const PREVIEW_CSP = previewCsp();

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Normalize the pathname of a `colony-preview:` request to the exact literal
 * relative path a manifest may list.
 *
 * Returns `""` for the origin root, which the host maps to the verified
 * entrypoint, or `null` when the path can never name a listed file. Encoded
 * separators, double encoding, backslashes, control characters, and dot
 * segments are all refused rather than repaired.
 */
export function normalizePreviewPath(pathname) {
  if (typeof pathname !== "string") return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("%") || decoded.includes("\\")) return null;
  if (hasControlCharacter(decoded)) return null;
  const stripped = decoded.replace(/^\/+/, "");
  if (stripped === "") return "";
  for (const segment of stripped.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return null;
    if (segment.endsWith(" ") || segment.endsWith(".")) return null;
  }
  return stripped;
}

/**
 * Parse a preview URL into `{ token, path }`, or `null` when it does not use
 * the preview scheme with an exact, credential-free origin and a normalized
 * path. This is the single parser used by both navigation guards and request
 * serving, so an origin that navigation accepts can never be served by a
 * different rule set (or the reverse).
 */
export function parsePreviewUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl === "") return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${PREVIEW_SCHEME}:`) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  const token = url.hostname.toLowerCase();
  if (token === "") return null;
  const path = normalizePreviewPath(url.pathname);
  if (path === null) return null;
  return { token, path };
}

/** Absolute entry URL for one preview token and verified entrypoint path. */
export function previewEntryUrl(token, entrypoint) {
  return `${PREVIEW_SCHEME}://${token}/${entrypoint}`;
}

/** Content type for a manifest MIME, with UTF-8 for textual payloads. */
export function previewContentType(mime) {
  return TEXTUAL_MIMES.has(mime) ? `${mime}; charset=utf-8` : mime;
}

/** Response headers for one verified file. */
export function previewHeaders(mime, { csp = PREVIEW_CSP } = {}) {
  return {
    "content-type": previewContentType(mime),
    "cache-control": "no-store",
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
  };
}

/** Minimal response headers for a refused request. */
export function previewMissHeaders() {
  return {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}
