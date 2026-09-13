/**
 * Pure presentation model for the native preview host.
 *
 * The host is "interactive" only while the native view is actually painting.
 * A ready handle that the native side has hidden (clipping, occlusion, or a
 * scroll position it cannot prove) is not interactive, so the verified capture
 * stays visible instead of a blank surface. Failures surface the capture plus
 * a real retry.
 */

import type {
  WebsiteNativeHandleState,
  WebsitePreviewHostStatus,
} from "./types";

export type WebsitePreviewAttachPhase =
  | "idle"
  | "attaching"
  | "waiting"
  | "error";

export type WebsitePreviewHostPresentation = {
  status: WebsitePreviewHostStatus;
  error?: string;
  /** True only while the native view is confirmed ready and painting. */
  interactive: boolean;
};

/**
 * What to do about host ownership: attach, wait for the current owner to
 * release, or nothing. `active` is checked before `claim`, so a retry while
 * this instance already owns the arbiter attaches instead of waiting.
 */
export function attachDecision(input: {
  eligible: boolean;
  active: boolean;
  claim: boolean;
}): "attach" | "wait" | "none" {
  if (!input.eligible) return "none";
  if (input.active || input.claim) return "attach";
  return "wait";
}

export function resolveHostPresentation(input: {
  enabled: boolean;
  occluded: boolean;
  tabHidden: boolean;
  available: boolean;
  phase: WebsitePreviewAttachPhase;
  attachError?: string;
  native: WebsiteNativeHandleState | null;
}): WebsitePreviewHostPresentation {
  const {
    enabled,
    occluded,
    tabHidden,
    available,
    phase,
    attachError,
    native,
  } = input;
  if (!enabled) {
    return { status: "idle", interactive: false };
  }
  if (occluded || tabHidden) {
    return { status: "detached", interactive: false };
  }
  if (!available) {
    return { status: "unavailable", interactive: false };
  }
  if (phase === "error") {
    return {
      status: "error",
      error: attachError,
      interactive: false,
    };
  }
  if (phase === "waiting") {
    return { status: "waiting", interactive: false };
  }
  if (native?.status === "failed") {
    return {
      status: "error",
      error: native.error ?? "The interactive preview stopped.",
      interactive: false,
    };
  }
  if (native?.status === "closed") {
    return { status: "detached", interactive: false };
  }
  if (native?.status === "ready") {
    return {
      status: "ready",
      interactive: native.visible,
    };
  }
  return { status: "attaching", interactive: false };
}

/** The verified capture is the fallback whenever the native view is not painting. */
export function shouldShowCaptureFallback(
  presentation: WebsitePreviewHostPresentation,
): boolean {
  return !presentation.interactive;
}
