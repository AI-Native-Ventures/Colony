/**
 * Request resolution for one mounted preview.
 *
 * Pure functions over a mounted entry: no Electron objects, no ambient state,
 * so the same rules run in source tests. Navigation authorization and request
 * serving share `parsePreviewUrl`, and only bytes returned by the verified
 * loader's `getFile` are ever served, only for the entry's own random token
 * and only when the request path is an exact listed key.
 *
 * Inline script authorization is computed per served HTML document, not only
 * for the entrypoint: a verified second page with its own inline menu or tab
 * script gets its own hash-authorized CSP. The never-serving path stays
 * `'self'` plus verified content hashes; there is no sanitizer here.
 */

import { collectInlineAuthorizations } from "./inline-script.mjs";
import {
  parsePreviewUrl,
  previewCsp,
  previewHeaders,
  previewMissHeaders,
} from "./scheme.mjs";

function refused(status, message) {
  return new Response(message, {
    status,
    headers: previewMissHeaders(),
  });
}

/**
 * True only for a listed file of this entry on this entry's scheme origin.
 * Both navigation and serving call this exact parser.
 */
export function isAllowedEntryUrl(entry, rawUrl) {
  if (entry.disposed || entry.site === null || entry.paths === null) {
    return false;
  }
  const parsed = parsePreviewUrl(rawUrl);
  if (parsed === null || parsed.token !== entry.token) return false;
  return servedPath(entry, parsed.path) !== null;
}

function servedPath(entry, path) {
  const resolved = path === "" ? entry.site.entrypoint : path;
  return entry.paths.has(resolved) ? resolved : null;
}

/**
 * CSP for one served file. HTML pages are authorized from their own verified
 * bytes and cached per path; other files keep the entrypoint CSP because the
 * header is ignored on non-documents. Truncation is surfaced once per entry so
 * the renderer can show a recoverable "some inline scripts stay blocked"
 * state instead of claiming full interaction.
 */
function cspForFile(entry, resolved, file) {
  if (file.mime !== "text/html") return entry.csp;
  if (entry.cspByPath === null || entry.cspByPath === undefined) {
    entry.cspByPath = new Map();
  }
  const cached = entry.cspByPath.get(resolved);
  if (cached !== undefined) return cached;
  const authorizations = collectInlineAuthorizations(file.bytes);
  const csp = previewCsp(authorizations);
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
  if (parsed === null || parsed.token !== entry.token) {
    return refused(404, "Not found");
  }
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
    }),
  });
}
