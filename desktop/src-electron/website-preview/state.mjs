/**
 * Frozen state snapshots for the preview host.
 *
 * Kept separate from the host so the same scoped record is built by the host,
 * the state subscription, and source tests without pulling in Electron
 * wiring. A record contains identity, status, visibility, and an error
 * string; it never contains artifact bytes or secrets.
 */

/** Frozen state record for one entry; `status` overrides the derived value. */
export function previewState(entry, status) {
  const resolved =
    status ??
    (entry.failed
      ? "failed"
      : entry.state === "ready"
        ? "ready"
        : entry.state === "closed"
          ? "closed"
          : "opening");
  return Object.freeze({
    handle: entry.handle,
    scopeId: entry.key,
    communityId: entry.communityId,
    jobId: entry.jobId,
    threadRoot: entry.threadRoot,
    revision: entry.revision,
    manifestSha256: entry.manifestSha256,
    viewport: entry.viewport,
    pixelWidth: entry.pixelWidth,
    pixelHeight: entry.pixelHeight,
    status: resolved,
    visible:
      resolved === "ready" &&
      entry.requestedVisible &&
      entry.layout?.visible === true &&
      !entry.failed,
    inlineScriptsTruncated: entry.inlineScriptsTruncated === true,
    error: entry.lastError,
  });
}
