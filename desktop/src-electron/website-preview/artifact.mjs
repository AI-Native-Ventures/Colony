import { PreviewArtifactError } from "./errors.mjs";
import {
  MAX_MANIFEST_BYTES,
  parsePreviewManifest,
  sha256Hex,
  validateArtifactRef,
} from "./manifest.mjs";
import {
  createBoundedSignal,
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  fetchBoundBytes,
  resolveDependencies,
  throwIfAborted,
  validateAbortSignal,
  validateDeadlineMs,
  validateMaxRedirects,
  validateTimeoutMs,
} from "./network.mjs";

export { PreviewArtifactError } from "./errors.mjs";
export {
  isBlockedHostName,
  isPrivateAddress,
} from "./address.mjs";
export {
  ALLOWED_MIMES,
  MAX_FILE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_PATH_LEN,
  MAX_PREVIEW_FILES,
  MAX_TOTAL_BYTES,
  MAX_URL_LEN,
  PREVIEW_SCHEMA,
  parsePreviewManifest,
  sha256Hex,
  validateArtifactRef,
  validateAssetPath,
  validateMime,
  validatePublicUrl,
  validateSha256,
} from "./manifest.mjs";
export {
  ABORT_CODE,
  buildHttpsRequestOptions,
  createDefaultDependencies,
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  fetchBoundBytes,
  MAX_DEADLINE_MS,
  MAX_MAX_REDIRECTS,
  MAX_TIMEOUT_MS,
  TIMEOUT_CODE,
} from "./network.mjs";

function sizeMismatch(path, expected, actual) {
  return new PreviewArtifactError(
    "size_mismatch",
    `file ${JSON.stringify(path)} is ${actual} bytes, manifest declared ${expected}`,
    { path, expected, actual },
  );
}

function digestMismatch(label, expected, actual) {
  return new PreviewArtifactError(
    "digest_mismatch",
    `${label} digest is ${actual}, expected ${expected}`,
    { label, expected, actual },
  );
}

/**
 * Build a frozen metadata record. Verified bytes stay in the loader's private
 * store and are deliberately absent here; `getFile` is the only byte accessor.
 */
function fileMetadata(file, contentType) {
  return Object.freeze({
    path: file.path,
    url: file.url,
    mime: file.mime,
    size: file.size,
    sha256: file.sha256,
    contentType,
  });
}

/**
 * Download and fully verify one preview artifact.
 *
 * `manifestRef.url` must serve the raw manifest bytes whose SHA-256 is
 * `manifestRef.sha256`; every file hash covers the raw file bytes. The loader
 * returns a frozen value only after the manifest and every listed file has
 * been fetched, length-checked, and digest-checked, so unverified bytes can
 * never reach a renderer:
 *
 *   {
 *     schema, entrypoint, manifestSha256,
 *     files,             // frozen array of frozen metadata records (no bytes)
 *     entrypointFile,    // frozen metadata record for the entrypoint (no bytes)
 *     getFile(path),     // frozen metadata + fresh `bytes` copy, or null
 *   }
 *
 * Verified bodies live only in a private store. `getFile` copies the bytes on
 * every call, so a caller mutating a returned record or buffer can never
 * change what a later read serves. Buffers are intentionally not frozen
 * (freezing a populated typed array throws).
 *
 * `dependencies` is `{lookup, open}`; omit it in production for real DNS and
 * HTTPS, and inject fakes in tests. `timeoutMs` caps one request, `deadlineMs`
 * caps the whole load, and `signal` cancels it. There is no environment
 * variable bypass.
 */
export async function loadWebsitePreview(options = {}) {
  const {
    manifestRef,
    dependencies,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    deadlineMs = DEFAULT_DEADLINE_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    signal,
  } = options ?? {};
  const ref = validateArtifactRef(manifestRef);
  const transport = resolveDependencies(dependencies);
  const requestTimeoutMs = validateTimeoutMs(timeoutMs);
  const totalDeadlineMs = validateDeadlineMs(deadlineMs);
  const redirectLimit = validateMaxRedirects(maxRedirects);
  const callerSignal = validateAbortSignal(signal);

  const scope = createBoundedSignal({
    deadlineMs: totalDeadlineMs,
    signal: callerSignal,
  });
  const fetchOptions = {
    dependencies: transport,
    timeoutMs: requestTimeoutMs,
    deadlineMs: totalDeadlineMs,
    maxRedirects: redirectLimit,
    signal: scope.signal,
  };

  try {
    throwIfAborted(scope.signal);
    const manifestFetch = await fetchBoundBytes(ref.url, {
      ...fetchOptions,
      maxBytes: MAX_MANIFEST_BYTES,
      label: "manifest",
    });
    const manifestSha256 = sha256Hex(manifestFetch.bytes);
    if (manifestSha256 !== ref.sha256) {
      throw digestMismatch("manifest", ref.sha256, manifestSha256);
    }
    const manifest = parsePreviewManifest(manifestFetch.bytes);

    // Private verified store. Its buffers are never exposed; `getFile` hands
    // out fresh copies so no caller can mutate bytes a later read will serve.
    const store = new Map();
    for (const file of manifest.files) {
      throwIfAborted(scope.signal);
      const fetched = await fetchBoundBytes(file.url, {
        ...fetchOptions,
        maxBytes: file.size,
        label: file.path,
      });
      if (fetched.bytes.length !== file.size) {
        throw sizeMismatch(file.path, file.size, fetched.bytes.length);
      }
      const actual = sha256Hex(fetched.bytes);
      if (actual !== file.sha256) {
        throw digestMismatch(file.path, file.sha256, actual);
      }
      store.set(file.path, {
        metadata: fileMetadata(file, fetched.contentType),
        bytes: Buffer.from(fetched.bytes),
      });
    }

    const files = Object.freeze(
      [...store.values()].map((entry) => entry.metadata),
    );
    const getFile = (path) => {
      if (typeof path !== "string") return null;
      const entry = store.get(path);
      if (entry === undefined) return null;
      return Object.freeze({
        ...entry.metadata,
        bytes: Buffer.from(entry.bytes),
      });
    };

    return Object.freeze({
      schema: manifest.schema,
      entrypoint: manifest.entrypoint,
      manifestSha256,
      files,
      entrypointFile:
        files.find((file) => file.path === manifest.entrypoint) ?? null,
      getFile,
    });
  } finally {
    scope.dispose();
  }
}
