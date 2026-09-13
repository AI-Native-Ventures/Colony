/**
 * Pure helpers for artifact verification. Kept free of React so they can be
 * unit-tested under node --test and reused by the binding hook.
 */

import type { WebsiteArtifactRef } from "./types";

/**
 * Identity of one artifact load request. Two requests with the same key may
 * share a rendered image; a changed URL, hash, enabled flag, or missing loader
 * always produces a new key so stale bytes can never render under a new label.
 */
export function verifiedArtifactRequestKey(input: {
  artifact: WebsiteArtifactRef | null;
  enabled: boolean;
  hasLoader: boolean;
}): string | null {
  if (!input.enabled || !input.hasLoader || !input.artifact) return null;
  const url = input.artifact.url;
  const sha256 = input.artifact.sha256.toLowerCase();
  if (url.length === 0 || sha256.length === 0) return null;
  return `${sha256}\u0000${url}`;
}

/**
 * Whether a loader-returned object URL points at locally verified bytes rather
 * than the remote artifact URL. Accepted: `blob:`, `data:`, `asset:`, `file:`,
 * and loopback asset hosts used by the bundled webviews. A public `http(s)`
 * URL, including the artifact's own remote URL, is never local and is refused.
 */
export function isLocalArtifactUrl(
  objectUrl: string,
  remoteUrl?: string | null,
): boolean {
  if (!objectUrl) return false;
  if (remoteUrl && objectUrl === remoteUrl) return false;
  let parsed: URL;
  try {
    parsed = new URL(objectUrl);
  } catch {
    return false;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (
    protocol === "blob:" ||
    protocol === "data:" ||
    protocol === "asset:" ||
    protocol === "file:"
  ) {
    return true;
  }
  if (protocol !== "http:" && protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return (
    host === "asset.localhost" ||
    host === "tauri.localhost" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}
