import * as React from "react";

import {
  computeHostBoundsUpdate,
  websitePreviewHostArbiter,
} from "./previewLogic";
import {
  attachDecision,
  resolveHostPresentation,
  type WebsitePreviewAttachPhase,
} from "./previewHostState";
import {
  WEBSITE_PREVIEW_PIXEL_SIZES,
  type WebsiteHostBoundsProvider,
  type WebsiteNativeHandleState,
  type WebsitePreviewHostAdapter,
  type WebsitePreviewHostHandle,
  type WebsitePreviewHostStatus,
  type WebsitePreviewViewport,
  type WebsiteRevisionRecord,
} from "./types";

export type WebsitePreviewHostState = {
  status: WebsitePreviewHostStatus;
  error?: string;
  /** True only while the native view is confirmed ready and painting. */
  interactive: boolean;
  /** False when the adapter probe says the host is not installed. */
  available: boolean;
  /** Re-attach after a failure; works while this view still owns the host. */
  retry: () => void;
  /** Explicitly hand the single host to this view (user action). */
  requestActivation: () => void;
};

function windowBounds(): {
  top: number;
  left: number;
  right: number;
  bottom: number;
} {
  const width =
    typeof window === "undefined" ? 0 : Math.max(0, window.innerWidth);
  const height =
    typeof window === "undefined" ? 0 : Math.max(0, window.innerHeight);
  return { top: 0, left: 0, right: width, bottom: height };
}

/**
 * Attach the isolated native preview host to a container element.
 *
 * Ownership is sticky while the view stays eligible; revision and viewport
 * changes re-attach without releasing the host, and occlusion or a hidden
 * document only flips native visibility rather than remounting the view. The
 * live readiness comes from the handle's optional state stream, separately
 * from attachment: an attached-but-hidden native view is not interactive, so
 * the surface keeps showing the verified capture instead of going blank. A
 * later failure surfaces the capture plus a real retry.
 *
 * Two views of the same job do not error: the second waits, waking when the
 * host is released, and the user can explicitly move the host with
 * `requestActivation`.
 */
export function useWebsitePreviewHost(options: {
  adapter?: WebsitePreviewHostAdapter;
  enabled: boolean;
  occluded?: boolean;
  revision: WebsiteRevisionRecord | null;
  viewport: WebsitePreviewViewport;
  containerRef: React.RefObject<HTMLElement | null>;
  communityId: string;
  jobId: string;
  threadRoot: string;
  /**
   * Returns the visible app window. Supply a stable callback (useCallback);
   * the latest value is read on every bounds update, not captured.
   */
  getClipBounds?: WebsiteHostBoundsProvider;
}): WebsitePreviewHostState {
  const {
    adapter,
    containerRef,
    enabled,
    getClipBounds,
    jobId,
    occluded,
    revision,
    threadRoot,
    viewport,
    communityId,
  } = options;
  const instanceId = React.useId();
  const [phase, setPhase] = React.useState<WebsitePreviewAttachPhase>("idle");
  const [attachError, setAttachError] = React.useState<string | undefined>();
  const [native, setNative] = React.useState<WebsiteNativeHandleState | null>(
    null,
  );
  const [available, setAvailable] = React.useState(false);
  const [tabHidden, setTabHidden] = React.useState(
    () => typeof document !== "undefined" && document.hidden,
  );
  const [retryToken, setRetryToken] = React.useState(0);
  const handleRef = React.useRef<WebsitePreviewHostHandle | null>(null);
  const clipRef = React.useRef<WebsiteHostBoundsProvider | undefined>(
    getClipBounds,
  );
  clipRef.current = getClipBounds;
  const occludedRef = React.useRef(Boolean(occluded));
  occludedRef.current = Boolean(occluded);
  const tabHiddenRef = React.useRef(tabHidden);
  tabHiddenRef.current = tabHidden;
  const scheduleVisibilityRef = React.useRef<
    (occluded: boolean, tabHidden: boolean) => void
  >(() => {});
  const attachKeyRef = React.useRef<string | null>(null);

  const previewUrl = revision?.preview.url ?? null;
  const previewSha256 = revision?.preview.sha256 ?? null;
  const revisionNumber = revision?.revision ?? 0;
  const hostWanted =
    enabled &&
    Boolean(adapter) &&
    available &&
    Boolean(previewUrl) &&
    Boolean(previewSha256) &&
    revisionNumber > 0;

  React.useEffect(() => {
    const onVisibilityChange = () => setTabHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    if (!adapter) {
      setAvailable(false);
      return;
    }
    if (!adapter.isAvailable) {
      setAvailable(true);
      return;
    }
    Promise.resolve(adapter.isAvailable())
      .then((value) => {
        if (!cancelled) setAvailable(Boolean(value));
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  // Ownership lives with want/availability, not with visibility, so an
  // occluded preview is hidden rather than torn down and remounted.
  React.useEffect(() => {
    if (!hostWanted) return;
    websitePreviewHostArbiter.claim(instanceId);
    return () => {
      const current = handleRef.current;
      handleRef.current = null;
      if (current) {
        try {
          void current.close();
        } catch {
          // Adapter teardown must not throw through React cleanup.
        }
      }
      websitePreviewHostArbiter.release(instanceId);
    };
  }, [hostWanted, instanceId]);

  // Visibility-only updates never re-run the attach effect. The current
  // values are passed through so the dependency is the real input.
  React.useEffect(() => {
    scheduleVisibilityRef.current(Boolean(occluded), tabHidden);
  }, [occluded, tabHidden]);

  const wake = React.useCallback(() => {
    setRetryToken((token) => token + 1);
  }, []);

  React.useEffect(() => {
    // Every attach attempt is identified by its scope plus the retry token:
    // queued bounds work from a superseded attempt is ignored, and a retry
    // genuinely re-enters this effect with a new attempt key.
    const attachKey = [
      communityId,
      jobId,
      threadRoot,
      previewUrl,
      previewSha256,
      String(revisionNumber),
      viewport,
      String(retryToken),
    ].join("\u0000");
    attachKeyRef.current = attachKey;
    if (!enabled) {
      setPhase("idle");
      setAttachError(undefined);
      setNative(null);
      return;
    }
    if (
      !adapter ||
      !available ||
      !previewUrl ||
      !previewSha256 ||
      !revisionNumber
    ) {
      setPhase("idle");
      setAttachError(undefined);
      setNative(null);
      return;
    }
    const unsubscribe = websitePreviewHostArbiter.subscribe(instanceId, wake);
    const decision = attachDecision({
      eligible: true,
      active: websitePreviewHostArbiter.isActive(instanceId),
      claim: websitePreviewHostArbiter.claim(instanceId),
    });
    if (decision === "wait") {
      setPhase("waiting");
      setAttachError(undefined);
      setNative(null);
      return unsubscribe;
    }
    const container = containerRef.current;
    if (!container) {
      setPhase("idle");
      setAttachError(undefined);
      setNative(null);
      return unsubscribe;
    }

    let abort = false;
    let frame = 0;
    let observer: ResizeObserver | undefined;
    let unsubscribeNative: (() => void) | undefined;
    const controller = new AbortController();

    const updateBounds = () => {
      if (attachKeyRef.current !== attachKey) return;
      const element = containerRef.current;
      const current = handleRef.current;
      if (!element || !current) return;
      if (occludedRef.current || tabHiddenRef.current) {
        current.setVisible(false);
        return;
      }
      const rect = element.getBoundingClientRect();
      const update = computeHostBoundsUpdate({
        element: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        },
        clip: clipRef.current?.() ?? null,
        windowBounds: windowBounds(),
      });
      if (!update) {
        current.setVisible(false);
        return;
      }
      current.setBounds(update);
      current.setVisible(update.visible);
    };
    const scheduleBounds = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateBounds);
    };
    scheduleVisibilityRef.current = () => scheduleBounds();

    setPhase("attaching");
    setAttachError(undefined);
    setNative(null);
    const size = WEBSITE_PREVIEW_PIXEL_SIZES[viewport];
    const initialRect = container.getBoundingClientRect();
    adapter
      .attach(
        container,
        {
          communityId,
          jobId,
          threadRoot,
          manifest: { url: previewUrl, sha256: previewSha256 },
          revision: revisionNumber,
          viewport,
          pixelWidth: size.width,
          pixelHeight: size.height,
          ...(initialRect.width > 0 && initialRect.height > 0
            ? {
                bounds: {
                  x: initialRect.left,
                  y: initialRect.top,
                  width: initialRect.width,
                  height: initialRect.height,
                },
              }
            : {}),
          clip: clipRef.current?.() ?? null,
          visible: !(occludedRef.current || tabHiddenRef.current),
        },
        controller.signal,
      )
      .then((attached) => {
        if (abort) {
          void attached.close();
          return;
        }
        handleRef.current = attached;
        unsubscribeNative = attached.subscribe?.((state) => {
          if (abort) return;
          setNative(state);
        });
        if (!attached.subscribe) {
          setNative({ status: "ready", visible: true });
        }
        observer = new ResizeObserver(scheduleBounds);
        observer.observe(container);
        window.addEventListener("scroll", scheduleBounds, true);
        window.addEventListener("resize", scheduleBounds);
        updateBounds();
      })
      .catch((cause: unknown) => {
        if (abort || controller.signal.aborted) return;
        scheduleVisibilityRef.current = () => {};
        setPhase("error");
        setAttachError(
          cause instanceof Error
            ? cause.message
            : "The interactive preview could not be started.",
        );
        setNative(null);
      });

    return () => {
      abort = true;
      controller.abort();
      unsubscribe();
      unsubscribeNative?.();
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("scroll", scheduleBounds, true);
      window.removeEventListener("resize", scheduleBounds);
      scheduleVisibilityRef.current = () => {};
      if (attachKeyRef.current === attachKey) attachKeyRef.current = null;
      const current = handleRef.current;
      handleRef.current = null;
      if (current) {
        try {
          void current.close();
        } catch {
          // Adapter teardown must not throw through React cleanup.
        }
      }
    };
  }, [
    adapter,
    available,
    communityId,
    containerRef,
    enabled,
    instanceId,
    jobId,
    previewSha256,
    previewUrl,
    retryToken,
    revisionNumber,
    threadRoot,
    viewport,
    wake,
  ]);

  const presentation = resolveHostPresentation({
    enabled,
    occluded: Boolean(occluded),
    tabHidden,
    available,
    phase,
    attachError,
    native,
  });

  return {
    status: presentation.status,
    error: presentation.error,
    interactive: presentation.interactive,
    available,
    retry: () => setRetryToken((token) => token + 1),
    requestActivation: () => {
      websitePreviewHostArbiter.activate(instanceId);
    },
  };
}
