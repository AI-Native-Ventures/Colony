/**
 * Bounded, hash-verified single-artifact loading for the renderer.
 *
 * Captures, QA reports, and handover assets are plain artifact refs. This
 * module fetches exactly one ref through the loader's pinned transport,
 * rejects a digest or size mismatch, and returns the bytes plus metadata. It
 * never returns secrets, cookies, or unbounded payloads: the response is
 * capped at the loader's single-file limit.
 */

import {
  createDefaultDependencies,
  fetchBoundBytes,
  MAX_FILE_BYTES,
  sha256Hex,
  validateArtifactRef,
} from "./artifact.mjs";
import { PreviewHostError } from "./host-errors.mjs";

/** Hard cap on one IPC artifact response. */
export const MAX_LOADED_ARTIFACT_BYTES = MAX_FILE_BYTES;

/**
 * Fetch and verify one artifact ref.
 *
 * `dependencies` is injectable for source tests; production uses the loader's
 * pinned DNS + HTTPS transport. Returns frozen `{ sha256, size, contentType,
 * bytes }`, never a mutable or unverified value.
 */
export async function loadVerifiedArtifact({
  ref,
  dependencies,
  timeoutMs,
  deadlineMs,
  signal,
} = {}) {
  const artifact = validateArtifactRef(ref);
  const transport = dependencies ?? createDefaultDependencies();
  const fetched = await fetchBoundBytes(artifact.url, {
    dependencies: transport,
    maxBytes: MAX_LOADED_ARTIFACT_BYTES,
    label: "artifact",
    timeoutMs,
    deadlineMs,
    signal,
  });
  const digest = sha256Hex(fetched.bytes);
  if (digest !== artifact.sha256) {
    throw new PreviewHostError(
      "artifact_digest_mismatch",
      "the artifact bytes do not match the requested hash",
    );
  }
  return Object.freeze({
    sha256: digest,
    size: fetched.bytes.byteLength,
    contentType: fetched.contentType,
    bytes: fetched.bytes,
  });
}
