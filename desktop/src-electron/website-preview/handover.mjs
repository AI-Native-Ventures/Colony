/**
 * Safe, hash-verified handover download.
 *
 * The handover record names approved source and asset artifact refs. Canonical
 * refs are `{ url, sha256 }`; a `size` is optional and, when present, must
 * match the fetched length exactly. Every item is fetched through the pinned
 * transport into a fresh private staging directory under the chosen location,
 * verified there, and only then linked into place without overwriting.
 *
 * Staging is created with `mkdtemp`, so no preexisting intermediate path is
 * ever traversed on the way in. Finalization walks each destination directory
 * component with `lstat` and refuses to follow or replace a symlink, file, or
 * any other preexisting entry. A destination file that already matches the
 * approved hash is reported `alreadyPresent`, so retrying after a partial
 * failure is recoverable instead of an irrecoverable conflict. Only the
 * staging directory this call created is ever removed, and only after all
 * verified bytes are safe.
 */

import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  createDefaultDependencies,
  fetchBoundBytes,
  MAX_FILE_BYTES,
  sha256Hex,
  validateArtifactRef,
} from "./artifact.mjs";
import { PreviewHostError } from "./host-errors.mjs";
import { validateAssetPath } from "./manifest.mjs";

/** Maximum artifacts in one handover download. */
export const MAX_HANDOVER_ITEMS = 64;
/** Total bytes one handover download may write. */
export const MAX_HANDOVER_TOTAL_BYTES = 64 * 1024 * 1024;
/** Prefix for the private staging directory created under the destination. */
export const HANDOVER_STAGING_PREFIX = ".colony-handover-";

function invalid(code, message, details) {
  return new PreviewHostError(code, message, details);
}

function defaultFileSystem() {
  return Object.freeze({
    link,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    unlink,
    writeFile,
  });
}

async function lstatOrNull(fileSystem, target) {
  try {
    return await fileSystem.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function validateItem(item, index) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw invalid("invalid_handover", `items[${index}] must be an object`);
  }
  if (typeof item.path !== "string") {
    throw invalid("invalid_handover", `items[${index}].path must be a string`);
  }
  validateAssetPath(item.path);
  // Canonical artifact refs carry url + sha256. A size is optional and, when
  // supplied, must match the fetched length exactly rather than being a
  // ceiling the caller had to invent.
  let size;
  if (item.size !== undefined) {
    if (!Number.isSafeInteger(item.size) || item.size < 0) {
      throw invalid("invalid_handover", `items[${index}].size is invalid`);
    }
    if (item.size > MAX_FILE_BYTES) {
      throw invalid(
        "invalid_handover",
        `items[${index}].size exceeds the ${MAX_FILE_BYTES} byte limit`,
      );
    }
    size = item.size;
  }
  const ref = validateArtifactRef({ url: item.url, sha256: item.sha256 });
  return { path: item.path, size, ref };
}

function rejectDuplicatePaths(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const folded = entry.path.toLowerCase();
    const existing = seen.get(folded);
    if (existing !== undefined) {
      throw invalid(
        "handover_duplicate_path",
        `handover paths ${JSON.stringify(existing)} and ${JSON.stringify(entry.path)} collide`,
      );
    }
    seen.set(folded, entry.path);
  }
}

/**
 * Create each destination directory without following preexisting entries.
 * A symlink, file, or any non-directory in the chain is a conflict: it is
 * preserved and the item fails, which keeps a planted symlink from redirecting
 * a write outside the chosen directory.
 */
async function ensureDirectoryChain(fileSystem, root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const existing = await lstatOrNull(fileSystem, current);
    if (existing === null) {
      await fileSystem.mkdir(current, { mode: 0o700 });
      continue;
    }
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw invalid(
        "handover_conflict",
        `${current} already exists and is not a directory`,
      );
    }
  }
}

async function classifyExisting(fileSystem, info, destination, entry) {
  if (info.isSymbolicLink() || !info.isFile()) {
    return { kind: "conflict" };
  }
  let bytes;
  try {
    bytes = await fileSystem.readFile(destination);
  } catch {
    return { kind: "conflict" };
  }
  if (sha256Hex(bytes) === entry.ref.sha256) {
    return { kind: "alreadyPresent", size: bytes.byteLength };
  }
  return { kind: "conflict" };
}

/**
 * Download a handover to disk.
 *
 * `chooseDirectory(window)` must resolve to a directory path or `null` when
 * the user cancels (nothing is created before it resolves). `dependencies`
 * and `fileSystem` are injectable for source tests.
 *
 * Returns frozen `{ directory, complete, files, alreadyPresent, failed }`.
 * `files` are the newly written items, `alreadyPresent` are destinations that
 * already held the approved bytes, and `failed` are the items a retry should
 * attempt again. A thrown error means nothing from this attempt was
 * finalized and staging was removed.
 */
export async function downloadHandover({
  window,
  items,
  chooseDirectory,
  dependencies,
  fileSystem,
  signal,
  assertCurrent,
} = {}) {
  if (typeof chooseDirectory !== "function") {
    throw invalid("invalid_handover", "chooseDirectory must be a function");
  }
  if (assertCurrent !== undefined && typeof assertCurrent !== "function") {
    throw invalid("invalid_handover", "assertCurrent must be a function");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw invalid(
      "invalid_handover",
      "handover items must be a non-empty array",
    );
  }
  if (items.length > MAX_HANDOVER_ITEMS) {
    throw invalid(
      "invalid_handover",
      `handover may contain at most ${MAX_HANDOVER_ITEMS} items`,
    );
  }
  const entries = items.map((item, index) => validateItem(item, index));
  rejectDuplicatePaths(entries);
  // A declared total over budget is knowable before any work; canonical refs
  // without sizes are bounded by the per-item cap and the running total.
  const declaredTotal = entries.reduce(
    (sum, entry) => sum + (entry.size ?? 0),
    0,
  );
  if (declaredTotal > MAX_HANDOVER_TOTAL_BYTES) {
    throw invalid(
      "handover_too_large",
      `handover declares more than ${MAX_HANDOVER_TOTAL_BYTES} bytes`,
    );
  }

  const directory = await chooseDirectory(window);
  if (typeof directory !== "string" || directory === "") {
    throw invalid("handover_cancelled", "the handover download was cancelled");
  }
  // The caller's context may have changed while the picker was open.
  assertCurrent?.();
  const root = path.resolve(directory);
  const fs = fileSystem ?? defaultFileSystem();
  const rootInfo = await fs.stat(root).catch(() => null);
  if (rootInfo === null || !rootInfo.isDirectory()) {
    throw invalid(
      "invalid_handover",
      "the chosen handover directory is not a directory",
    );
  }

  const transport = dependencies ?? createDefaultDependencies();
  const staging = await fs.mkdtemp(path.join(root, HANDOVER_STAGING_PREFIX));
  const staged = [];
  const written = [];
  const alreadyPresent = [];
  const failed = [];
  let total = 0;

  try {
    for (const entry of entries) {
      const fetched = await fetchBoundBytes(entry.ref.url, {
        dependencies: transport,
        maxBytes: entry.size ?? MAX_FILE_BYTES,
        label: entry.path,
        signal,
      });
      if (entry.size !== undefined && fetched.bytes.byteLength !== entry.size) {
        throw invalid(
          "handover_size_mismatch",
          `${entry.path} is ${fetched.bytes.byteLength} bytes, expected ${entry.size}`,
        );
      }
      const digest = sha256Hex(fetched.bytes);
      if (digest !== entry.ref.sha256) {
        throw invalid(
          "artifact_digest_mismatch",
          `${entry.path} bytes do not match the approved hash`,
        );
      }
      total += fetched.bytes.byteLength;
      if (total > MAX_HANDOVER_TOTAL_BYTES) {
        throw invalid(
          "handover_too_large",
          `handover exceeds ${MAX_HANDOVER_TOTAL_BYTES} bytes`,
        );
      }
      const stagedPath = path.join(staging, ...entry.path.split("/"));
      await fs.mkdir(path.dirname(stagedPath), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(stagedPath, fetched.bytes, {
        flag: "wx",
        mode: 0o600,
      });
      staged.push({ ...entry, stagedPath, size: fetched.bytes.byteLength });
    }

    // Every hash and declared size is verified before anything is finalized.
    // If the caller's context changed during staging, nothing is written and
    // the finally block removes the staging directory.
    assertCurrent?.();
    for (const entry of staged) {
      const segments = entry.path.split("/");
      const destination = path.join(root, ...segments);
      try {
        await ensureDirectoryChain(fs, root, segments.slice(0, -1));
        const existing = await lstatOrNull(fs, destination);
        if (existing !== null) {
          const outcome = await classifyExisting(
            fs,
            existing,
            destination,
            entry,
          );
          if (outcome.kind === "alreadyPresent") {
            alreadyPresent.push(
              Object.freeze({
                path: entry.path,
                sha256: entry.ref.sha256,
                size: outcome.size,
              }),
            );
          } else {
            failed.push(
              Object.freeze({
                path: entry.path,
                code: "handover_conflict",
                message:
                  "a different file already exists at the destination and was preserved",
              }),
            );
          }
          continue;
        }
        await fs.link(entry.stagedPath, destination);
        await fs.unlink(entry.stagedPath).catch(() => {});
        written.push(
          Object.freeze({
            path: entry.path,
            sha256: entry.ref.sha256,
            size: entry.size,
          }),
        );
      } catch (error) {
        failed.push(
          Object.freeze({
            path: entry.path,
            code: error?.code ?? "handover_write_failed",
            message:
              error instanceof Error ? error.message : "handover write failed",
          }),
        );
      }
    }

    return Object.freeze({
      directory: root,
      complete: failed.length === 0,
      files: Object.freeze(written),
      alreadyPresent: Object.freeze(alreadyPresent),
      failed: Object.freeze(failed),
    });
  } finally {
    // Only the staging directory this call created is removed, and only
    // AFTER every verified byte is either finalized or reported failed.
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
