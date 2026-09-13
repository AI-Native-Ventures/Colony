import { validatePublicUrl } from "../website-preview/manifest.mjs";

/** Fixed CSS viewports used when evidence is captured. */
export const EVIDENCE_VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900 }),
  mobile: Object.freeze({ width: 390, height: 844 }),
});

/** Maximum page resources requested by one evidence session. */
export const MAX_EVIDENCE_REQUESTS = 256;
/** Maximum bytes returned to one evidence session across all resources. */
export const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
/** Maximum bytes returned for one public page resource. */
export const MAX_EVIDENCE_RESOURCE_BYTES = 8 * 1024 * 1024;
/** Maximum bytes retained for one PNG capture. */
export const MAX_EVIDENCE_CAPTURE_BYTES = 16 * 1024 * 1024;
/** Maximum action arguments accepted from a worker. */
export const MAX_EVIDENCE_TEXT_BYTES = 4_000;
/** Maximum lifetime of one host-mediated evidence session. */
export const MAX_EVIDENCE_SESSION_MS = 10 * 60 * 1000;
/** Maximum length of a single public URL received from a worker. */
export const MAX_EVIDENCE_URL_BYTES = 2_048;

// Company task identifiers can carry the signed `thread-task:` namespace.
// Keep the separator set explicit; these values are identifiers, never paths.
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,192}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid(message) {
  throw new Error(message);
}

/** Validate a server-owned community or job identifier. */
export function requireEvidenceId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    invalid(
      `${label} must be 1 to 192 letters, digits, dots, underscores, colons, or dashes`,
    );
  }
  return value;
}

/** Validate a UUID coordinate carried by a relay-authored record. */
export function requireEvidenceUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.toLowerCase())) {
    invalid(`${label} must be a canonical UUID`);
  }
  return value.toLowerCase();
}

/** Validate a canonical thread root supplied by the job authority. */
export function requireEvidenceThreadRoot(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid("threadRoot must be a lowercase SHA-256 identifier");
  }
  return value;
}

/** Validate a fixed evidence viewport. */
export function resolveEvidenceViewport(value) {
  if (typeof value !== "string" || !Object.hasOwn(EVIDENCE_VIEWPORTS, value)) {
    invalid("viewport must be desktop or mobile");
  }
  return value;
}

/** Return the exact CSS size for a fixed evidence viewport. */
export function evidenceViewportSize(value) {
  return EVIDENCE_VIEWPORTS[resolveEvidenceViewport(value)];
}

/** Validate a public HTTPS navigation/resource URL before DNS resolution. */
export function validateEvidenceUrl(value) {
  if (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > MAX_EVIDENCE_URL_BYTES
  ) {
    invalid(`Evidence URL must be at most ${MAX_EVIDENCE_URL_BYTES} bytes`);
  }
  return validatePublicUrl(value);
}

/** Only idempotent reads are allowed through the evidence browser. */
export function requireEvidenceReadMethod(value) {
  const method = typeof value === "string" ? value.toUpperCase() : "";
  if (method !== "GET") {
    invalid("Evidence browser only permits GET requests");
  }
  return method;
}

/** The page may render public content but cannot submit or open privileged work. */
export const EVIDENCE_CONTENT_SECURITY_POLICY =
  "default-src https:; base-uri 'none'; object-src 'none'; " +
  "form-action 'none'; connect-src https:; frame-src 'none'; " +
  "worker-src 'none'; child-src 'none'; " +
  "img-src https: data:; style-src https: 'unsafe-inline'; " +
  "script-src https: 'unsafe-inline'; font-src https: data:; " +
  "media-src https:; manifest-src https:; frame-ancestors 'none'";

/** Headers added to every public resource returned to Chromium. */
export function evidenceResponseHeaders(contentType) {
  const headers = new Headers();
  headers.set(
    "content-type",
    typeof contentType === "string" && contentType !== ""
      ? contentType
      : "application/octet-stream",
  );
  headers.set("cache-control", "no-store");
  headers.set("content-security-policy", EVIDENCE_CONTENT_SECURITY_POLICY);
  headers.set("cross-origin-resource-policy", "cross-origin");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), notifications=(), usb=()",
  );
  headers.set("x-content-type-options", "nosniff");
  // The host never forwards cookies or authorization headers. A wildcard is
  // therefore safe for public GET hydration across a page and its public API;
  // non-GET requests are rejected before they reach the transport.
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET");
  headers.set("access-control-allow-headers", "*");
  return headers;
}

/**
 * Validate the browser's actual network request before the pinned protocol
 * handler sees it. The protocol handler repeats this check, because a
 * webRequest callback is a policy guard rather than the transport boundary.
 */
export function isAllowedEvidenceRequest({ url, method, resourceType } = {}) {
  if (typeof method !== "string" || method.toUpperCase() !== "GET") {
    return false;
  }
  if (resourceType === "websocket" || resourceType === "serviceworker") {
    return false;
  }
  if (typeof url !== "string") return false;
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  try {
    validateEvidenceUrl(url);
    return true;
  } catch {
    return false;
  }
}

/** Validate an action descriptor without accepting executable input. */
export function validateEvidenceAction(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("Evidence action must be an object");
  }
  const { type } = value;
  if (type !== "snapshot" && type !== "click" && type !== "type") {
    invalid("Evidence action is unsupported");
  }
  if (type !== "snapshot") {
    if (
      typeof value.ref !== "string" ||
      !/^[a-f0-9]{16}-[1-9][0-9]{0,2}$/.test(value.ref)
    ) {
      invalid("Evidence action requires a snapshot reference");
    }
  }
  if (type === "type") {
    if (
      typeof value.text !== "string" ||
      Buffer.byteLength(value.text, "utf8") > MAX_EVIDENCE_TEXT_BYTES
    ) {
      invalid(`Evidence text must be at most ${MAX_EVIDENCE_TEXT_BYTES} bytes`);
    }
  }
  return value;
}
