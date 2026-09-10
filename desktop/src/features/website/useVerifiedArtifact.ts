import * as React from "react";

import {
  isLocalArtifactUrl,
  verifiedArtifactRequestKey,
} from "./artifactVerification";
import type {
  WebsiteArtifactLoader,
  WebsiteArtifactRef,
  WebsiteVerifiedArtifact,
} from "./types";

export type VerifiedArtifactState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; objectUrl: string; verifiedSha256: string }
  | {
      status: "error";
      /** Plain-language failure for the surface; no hash jargon here. */
      message: string;
      /** Optional technical detail (hashes, loader errors) for diagnostics. */
      diagnostics?: string;
      /**
       * Restarts the exact same request. Present on every error state returned
       * by the hook; optional so stored entries can be constructed without it.
       */
      retry?: () => void;
    };

type LoadedEntry = {
  key: string;
  state: VerifiedArtifactState;
};

/**
 * Load an artifact through the injected verifier. The returned object URL is
 * backed only by locally verified bytes; a missing loader, a load failure, a
 * hash mismatch, or a non-local URL is an explicit state. There is no fallback
 * to the remote URL.
 *
 * The ready state is keyed to the exact requested artifact: when the URL or
 * hash changes, the previous ready state is masked synchronously on the same
 * render, before any effect runs. An old image can therefore never appear
 * under a new version label.
 */
export function useVerifiedArtifact(options: {
  loader?: WebsiteArtifactLoader;
  artifact: WebsiteArtifactRef | null;
  enabled?: boolean;
}): VerifiedArtifactState {
  const { loader, artifact, enabled = true } = options;
  const requestKey = verifiedArtifactRequestKey({
    artifact,
    enabled,
    hasLoader: Boolean(loader),
  });
  const [entry, setEntry] = React.useState<LoadedEntry | null>(null);
  const [retryToken, setRetryToken] = React.useState(0);
  // The attempt key folds the retry token into the request identity, so a
  // retry is a genuinely new attempt (the effect re-runs), while the same
  // request and token still render the stored result.
  const attemptKey =
    requestKey === null ? null : `${requestKey}\u0000${retryToken}`;

  const artifactRef = React.useRef(artifact);
  artifactRef.current = artifact;

  React.useEffect(() => {
    const requested = artifactRef.current;
    if (!attemptKey || !loader || !requested) return;
    const key = attemptKey;
    let loaded: WebsiteVerifiedArtifact | null = null;
    const controller = new AbortController();
    setEntry({
      key,
      state: { status: "loading" },
    });
    loader
      .load({ url: requested.url, sha256: requested.sha256 }, controller.signal)
      .then((verified) => {
        if (controller.signal.aborted) {
          verified.revoke();
          return;
        }
        const expected = requested.sha256.toLowerCase();
        const actual = (verified.verifiedSha256 ?? "").toLowerCase();
        if (actual !== expected) {
          verified.revoke();
          setEntry({
            key,
            state: {
              status: "error",
              message:
                "This saved image did not match the version record, so it was not shown.",
              diagnostics: `Expected SHA-256 ${expected}; loader returned ${
                actual || "no hash"
              }.`,
            },
          });
          return;
        }
        if (!isLocalArtifactUrl(verified.objectUrl, requested.url)) {
          verified.revoke();
          setEntry({
            key,
            state: {
              status: "error",
              message:
                "The saved image was not available from local verified storage, so it was not shown.",
              diagnostics: `Loader returned a URL that is not a local verified object URL: ${verified.objectUrl}`,
            },
          });
          return;
        }
        loaded = verified;
        setEntry({
          key,
          state: {
            status: "ready",
            objectUrl: verified.objectUrl,
            verifiedSha256: verified.verifiedSha256,
          },
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setEntry({
          key,
          state: {
            status: "error",
            message: "The saved image for this version could not be loaded.",
            diagnostics: cause instanceof Error ? cause.message : String(cause),
          },
        });
      });
    return () => {
      controller.abort();
      loaded?.revoke();
      loaded = null;
    };
  }, [attemptKey, loader]);

  const state = ((): VerifiedArtifactState => {
    if (!attemptKey) return { status: "idle" };
    if (entry && entry.key === attemptKey) {
      if (entry.state.status !== "error") return entry.state;
      return {
        ...entry.state,
        retry: () => {
          setEntry(null);
          setRetryToken((token) => token + 1);
        },
      };
    }
    return { status: "loading" };
  })();

  return state;
}
