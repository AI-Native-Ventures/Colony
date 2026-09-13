import { createHash } from "node:crypto";

import {
  classifyHost,
  isBlockedHostName,
  isPrivateAddress,
} from "./address.mjs";
import { PreviewArtifactError } from "./errors.mjs";

/** Exact schema string for preview manifests. */
export const PREVIEW_SCHEMA = "colony.website-preview/1";
/** Maximum accepted raw manifest size in bytes (256 KiB). */
export const MAX_MANIFEST_BYTES = 262_144;
/** Maximum number of files in one manifest. */
export const MAX_PREVIEW_FILES = 512;
/** Maximum size of one preview file in bytes (16 MiB). */
export const MAX_FILE_BYTES = 16_777_216;
/** Maximum total size of all preview files in bytes (64 MiB). */
export const MAX_TOTAL_BYTES = 67_108_864;
/** Maximum length of an asset path in bytes. */
export const MAX_PATH_LEN = 1024;
/** Maximum length of any URL in bytes. */
export const MAX_URL_LEN = 2048;

/** MIME types a preview file may declare. */
export const ALLOWED_MIMES = Object.freeze([
  "text/html",
  "text/css",
  "text/plain",
  "text/javascript",
  "application/javascript",
  "application/json",
  "application/manifest+json",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/svg+xml",
  "image/webp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "font/woff",
  "font/woff2",
  "application/wasm",
]);
const ALLOWED_MIME_SET = new Set(ALLOWED_MIMES);
const MANIFEST_FIELDS = Object.freeze(["schema", "entrypoint", "files"]);
const FILE_FIELDS = Object.freeze(["path", "url", "sha256", "mime", "size"]);
const REF_FIELDS = Object.freeze(["url", "sha256"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** SHA-256 of `bytes`, lowercase hex. */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function invalidPath(path, reason) {
  return new PreviewArtifactError(
    "path_invalid",
    `invalid asset path ${JSON.stringify(path)}: ${reason}`,
    { path, reason },
  );
}

function requirePlainObject(value, fields, label, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PreviewArtifactError(code, `${label} must be a JSON object`);
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) {
      throw new PreviewArtifactError(
        code,
        `${label} has unknown field ${JSON.stringify(key)}`,
      );
    }
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) {
      throw new PreviewArtifactError(
        code,
        `${label} is missing field ${JSON.stringify(key)}`,
      );
    }
  }
  return value;
}

/** Validate a SHA-256 value: exactly 64 lowercase hex characters. */
export function validateSha256(value) {
  if (typeof value !== "string") {
    throw new PreviewArtifactError(
      "manifest_json",
      `sha256 must be a string, got ${JSON.stringify(value)}`,
    );
  }
  if (!SHA256_PATTERN.test(value)) {
    throw new PreviewArtifactError(
      "sha256_invalid",
      `sha256 must be 64 lowercase hex characters, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Validate a bare MIME type against the allowlist. */
export function validateMime(mime) {
  if (typeof mime !== "string") {
    throw new PreviewArtifactError(
      "manifest_json",
      `mime must be a string, got ${JSON.stringify(mime)}`,
    );
  }
  if (!ALLOWED_MIME_SET.has(mime)) {
    throw new PreviewArtifactError(
      "mime_invalid",
      `mime ${JSON.stringify(mime)} is not allowlisted`,
    );
  }
  return mime;
}

/**
 * Validate a literal relative asset path.
 *
 * Rejected: empty paths, paths over 1024 bytes, leading or trailing slashes,
 * backslashes, `%`, `?`, `#`, control characters, empty or `.` or `..`
 * segments, and segments ending in a space or dot.
 */
export function validateAssetPath(path) {
  if (typeof path !== "string") throw invalidPath(path, "must be a string");
  if (path === "") throw invalidPath(path, "must not be empty");
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_LEN) {
    throw invalidPath(path, "must be at most 1024 bytes");
  }
  if (path.startsWith("/") || path.endsWith("/")) {
    throw invalidPath(
      path,
      "must be relative without a leading or trailing slash",
    );
  }
  if (path.includes("\\"))
    throw invalidPath(path, "must not contain a backslash");
  if (path.includes("%"))
    throw invalidPath(path, "must not contain percent encoding");
  if (path.includes("?")) throw invalidPath(path, "must not contain a query");
  if (path.includes("#"))
    throw invalidPath(path, "must not contain a fragment");
  for (const character of path) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      throw invalidPath(path, "must not contain control characters");
    }
  }
  for (const segment of path.split("/")) {
    if (segment === "")
      throw invalidPath(path, "must not contain an empty segment");
    if (segment === ".")
      throw invalidPath(path, "must not contain a dot segment");
    if (segment === "..")
      throw invalidPath(path, "must not contain a parent segment");
    if (segment.endsWith(" ") || segment.endsWith(".")) {
      throw invalidPath(path, "segments must not end in a space or dot");
    }
  }
  return path;
}

/**
 * Validate a public artifact or source URL.
 *
 * Required: absolute HTTPS, at most 2048 bytes, no userinfo, no fragment, and a
 * host that is provably public without DNS. DNS resolution and redirect checks
 * are the loader's obligation (`network.mjs`).
 *
 * @returns {URL} the parsed URL
 */
export function validatePublicUrl(value) {
  if (typeof value !== "string") {
    throw new PreviewArtifactError("url_invalid", "url must be a string");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_URL_LEN) {
    throw new PreviewArtifactError(
      "url_invalid",
      `url exceeds 2048 bytes: ${value.length} characters`,
    );
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PreviewArtifactError(
      "url_invalid",
      `must be an absolute url: ${value}`,
    );
  }
  if (url.protocol !== "https:") {
    throw new PreviewArtifactError("url_insecure", `must use https: ${value}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new PreviewArtifactError(
      "url_credentials",
      `must not include credentials: ${value}`,
    );
  }
  if (url.hash !== "") {
    throw new PreviewArtifactError(
      "url_invalid",
      `must not include a fragment: ${value}`,
    );
  }
  const host = classifyHost(url.hostname);
  if (host.kind === "ip") {
    if (isPrivateAddress(host.address)) {
      throw new PreviewArtifactError(
        "url_blocked_host",
        `host is not public: ${host.address}`,
        { host: host.address },
      );
    }
  } else if (isBlockedHostName(host.name)) {
    throw new PreviewArtifactError(
      "url_blocked_host",
      `host is not public: ${host.name}`,
      { host: host.name },
    );
  }
  return url;
}

/** Validate an artifact ref `{url, sha256}`; the hash covers raw bytes. */
export function validateArtifactRef(value) {
  const ref = requirePlainObject(
    value,
    REF_FIELDS,
    "artifact ref",
    "ref_invalid",
  );
  if (typeof ref.url !== "string") {
    throw new PreviewArtifactError(
      "ref_invalid",
      "artifact ref url must be a string",
    );
  }
  validatePublicUrl(ref.url);
  validateSha256(ref.sha256);
  return Object.freeze({ url: ref.url, sha256: ref.sha256 });
}

/**
 * Parse and fully validate a preview manifest from its raw bytes.
 *
 * The size limit applies before JSON decoding. The manifest hash is the SHA-256
 * of the same raw byte slice. Unknown fields are rejected at every level, and
 * the returned object is deeply frozen.
 */
export function parsePreviewManifest(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new PreviewArtifactError(
      "manifest_bytes",
      "manifest bytes must be a Uint8Array",
    );
  }
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new PreviewArtifactError(
      "manifest_too_large",
      `manifest is ${bytes.byteLength} bytes, limit is ${MAX_MANIFEST_BYTES}`,
      { actual: bytes.byteLength, limit: MAX_MANIFEST_BYTES },
    );
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new PreviewArtifactError(
      "manifest_json",
      `manifest is not valid JSON: ${error.message}`,
    );
  }

  const manifest = requirePlainObject(
    value,
    MANIFEST_FIELDS,
    "manifest",
    "manifest_json",
  );
  if (manifest.schema !== PREVIEW_SCHEMA) {
    throw new PreviewArtifactError(
      "manifest_schema",
      `schema must be ${PREVIEW_SCHEMA}, got ${JSON.stringify(manifest.schema)}`,
      { schema: manifest.schema },
    );
  }
  if (typeof manifest.entrypoint !== "string") {
    throw new PreviewArtifactError(
      "manifest_json",
      "entrypoint must be a string",
    );
  }
  if (!Array.isArray(manifest.files)) {
    throw new PreviewArtifactError("manifest_json", "files must be an array");
  }
  if (manifest.files.length > MAX_PREVIEW_FILES) {
    throw new PreviewArtifactError(
      "too_many_files",
      `manifest has ${manifest.files.length} files, limit is ${MAX_PREVIEW_FILES}`,
      { actual: manifest.files.length, limit: MAX_PREVIEW_FILES },
    );
  }
  validateAssetPath(manifest.entrypoint);

  const exactPaths = new Set();
  const foldedPaths = new Map();
  const files = [];
  let total = 0;
  for (let index = 0; index < manifest.files.length; index += 1) {
    const raw = requirePlainObject(
      manifest.files[index],
      FILE_FIELDS,
      `files[${index}]`,
      "manifest_json",
    );
    if (typeof raw.path !== "string") {
      throw new PreviewArtifactError(
        "manifest_json",
        `files[${index}].path must be a string`,
      );
    }
    validateAssetPath(raw.path);
    if (exactPaths.has(raw.path)) {
      throw new PreviewArtifactError(
        "path_duplicate",
        `duplicate path ${JSON.stringify(raw.path)}`,
        { path: raw.path },
      );
    }
    exactPaths.add(raw.path);
    const folded = raw.path.toLowerCase();
    const existing = foldedPaths.get(folded);
    if (existing !== undefined) {
      throw new PreviewArtifactError(
        "path_ambiguous",
        `paths ${JSON.stringify(existing)} and ${JSON.stringify(raw.path)} differ only by case`,
        { path: raw.path, existing },
      );
    }
    foldedPaths.set(folded, raw.path);

    if (typeof raw.url !== "string") {
      throw new PreviewArtifactError(
        "manifest_json",
        `files[${index}].url must be a string`,
      );
    }
    validatePublicUrl(raw.url);
    validateSha256(raw.sha256);
    validateMime(raw.mime);
    if (!Number.isSafeInteger(raw.size) || raw.size < 0) {
      throw new PreviewArtifactError(
        "manifest_json",
        `files[${index}].size must be a non-negative safe integer`,
        { path: raw.path, size: raw.size },
      );
    }
    if (raw.size > MAX_FILE_BYTES) {
      throw new PreviewArtifactError(
        "file_too_large",
        `file ${JSON.stringify(raw.path)} is ${raw.size} bytes, limit is ${MAX_FILE_BYTES}`,
        { path: raw.path, size: raw.size, limit: MAX_FILE_BYTES },
      );
    }
    total += raw.size;
    if (total > MAX_TOTAL_BYTES) {
      throw new PreviewArtifactError(
        "total_too_large",
        `total size is ${total} bytes, limit is ${MAX_TOTAL_BYTES}`,
        { total, limit: MAX_TOTAL_BYTES },
      );
    }
    files.push(
      Object.freeze({
        path: raw.path,
        url: raw.url,
        sha256: raw.sha256,
        mime: raw.mime,
        size: raw.size,
      }),
    );
  }

  const entrypoint = files.find((file) => file.path === manifest.entrypoint);
  if (entrypoint === undefined) {
    throw new PreviewArtifactError(
      "entrypoint_missing",
      `entrypoint ${JSON.stringify(manifest.entrypoint)} is not listed in files`,
      { entrypoint: manifest.entrypoint },
    );
  }
  if (entrypoint.mime !== "text/html") {
    throw new PreviewArtifactError(
      "entrypoint_not_html",
      `entrypoint ${JSON.stringify(manifest.entrypoint)} must be text/html, got ${entrypoint.mime}`,
      { entrypoint: manifest.entrypoint, mime: entrypoint.mime },
    );
  }
  return Object.freeze({
    schema: PREVIEW_SCHEMA,
    entrypoint: manifest.entrypoint,
    files: Object.freeze(files),
  });
}
