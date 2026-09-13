/**
 * Native adapters for the Website Manager feature layer.
 *
 * The shared client (`desktop/src/shared/api/websitePreview.ts`) already
 * speaks the feature handle shape: `setBounds` takes `{ element, clip,
 * intersection?, visible }`, the handle exposes `subscribe`, the artifact
 * loader returns `{ objectUrl, verifiedSha256, revoke }`, and the bridge
 * prefixes typed failures as `"<code>: <message>"`. This module only binds
 * those to the feature interfaces and maps errors to honest UI states.
 *
 * No zoom is sent: the app pins the webview zoom to 1 and scales text through
 * the root font-size, so `getBoundingClientRect()` is already in window
 * coordinates.
 */

import {
  createWebsiteArtifactLoader,
  createWebsitePreviewAdapter,
  downloadWebsiteHandover,
  isWebsitePreviewAvailable,
  websitePreviewErrorCode,
} from "@/shared/api/websitePreview";

import type {
  WebsiteArtifactDownloadAdapter,
  WebsiteArtifactLoader,
  WebsiteArtifactRef,
  WebsiteNativeHandleState,
  WebsitePreviewHostAdapter,
} from "@/features/website/types";

function errorMessage(error: unknown): string {
  if (typeof error === "string" && error.length > 0) return error;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "The native preview host failed.";
}

function nativeErrorState(error: unknown): WebsiteNativeHandleState {
  const code = websitePreviewErrorCode(error);
  if (
    code === "preview_closed" ||
    code === "preview_aborted" ||
    code === "unknown_preview" ||
    code === "preview_disposed"
  ) {
    return { status: "closed", visible: false };
  }
  return { status: "failed", visible: false, error: errorMessage(error) };
}

/**
 * One host adapter per feature surface. The native adapter is created per
 * attach so its scoped state stream is routed to exactly that handle; state
 * that arrives before the feature `subscribe` call is buffered and replayed.
 */
export function createWebsiteHostAdapter(): WebsitePreviewHostAdapter | null {
  if (!isWebsitePreviewAvailable()) return null;
  return {
    isAvailable: () => true,
    async attach(container, request, signal) {
      const holder: {
        listener: ((state: WebsiteNativeHandleState) => void) | null;
        latest: WebsiteNativeHandleState | null;
      } = { listener: null, latest: null };
      const publish = (state: WebsiteNativeHandleState) => {
        holder.latest = state;
        holder.listener?.(state);
      };
      const native = createWebsitePreviewAdapter({
        onState: (state) =>
          publish({
            status: state.status,
            visible: state.visible,
            error: state.error,
          }),
        onError: (failure) => publish(nativeErrorState(failure.error)),
      });
      if (!native) {
        throw new Error("The native preview host is not available.");
      }
      const handle = await native.attach(
        container,
        {
          communityId: request.communityId,
          jobId: request.jobId,
          threadRoot: request.threadRoot,
          revision: request.revision,
          manifest: {
            url: request.manifest.url,
            sha256: request.manifest.sha256,
          },
          viewport: request.viewport,
          pixelWidth: request.pixelWidth,
          pixelHeight: request.pixelHeight,
          ...(request.bounds ? { bounds: request.bounds } : {}),
          clip: request.clip ?? null,
          visible: request.visible,
        },
        signal,
      );
      return {
        setBounds: (update) => handle.setBounds(update),
        setVisible: (visible) => handle.setVisible(visible),
        close: () => handle.close(),
        subscribe: (listener) => {
          holder.listener = listener;
          if (holder.latest) listener(holder.latest);
          return () => {
            if (holder.listener === listener) holder.listener = null;
          };
        },
      };
    },
  };
}

/**
 * Mock-only artifact loader seam. Playwright runs in a plain browser where the
 * Electron verified fetcher is absent; specs install a fixture loader under
 * this global so captures and QA reports can render as mocked proof. Nothing
 * installs it in the packaged app, and it still has to return local object
 * URLs with the exact declared hash, which `useVerifiedArtifact` re-checks.
 */
function e2eArtifactLoaderOverride(): WebsiteArtifactLoader | null {
  const candidate = (
    globalThis as { __BUZZ_E2E_WEBSITE_ARTIFACT_LOADER__?: unknown }
  ).__BUZZ_E2E_WEBSITE_ARTIFACT_LOADER__;
  if (
    !candidate ||
    typeof (candidate as WebsiteArtifactLoader).load !== "function"
  ) {
    return null;
  }
  return candidate as WebsiteArtifactLoader;
}

/** Feature artifact loader bound to one community. */
export function createWebsiteArtifactLoaderAdapter(
  communityId: string,
): WebsiteArtifactLoader {
  const override = e2eArtifactLoaderOverride();
  if (override) return override;
  const loader = createWebsiteArtifactLoader(communityId);
  return {
    load: (artifact, signal) => loader.load(artifact, signal),
  };
}

/**
 * Feature download adapter bound to one community. Each call downloads exactly
 * one canonical artifact ref through the native verified path; a partial or
 * failed result is raised so the row can show a real error.
 */
export function createWebsiteDownloadAdapter(
  communityId: string,
): WebsiteArtifactDownloadAdapter {
  return {
    async download(
      artifact: WebsiteArtifactRef,
      input: { path: string },
    ): Promise<void> {
      const result = await downloadWebsiteHandover(
        [
          {
            path: input.path,
            url: artifact.url,
            sha256: artifact.sha256,
          },
        ],
        communityId,
      );
      if (!result.complete) {
        const failure = result.failed[0];
        throw new Error(
          failure
            ? `${failure.code}: ${failure.message}`
            : "The verified download did not complete.",
        );
      }
    },
  };
}
