/**
 * Pure state for the handover panel. Draft and download work are bound to the
 * exact job/task/channel plus approved revision and manifest hash. A response
 * for another scope is rejected instead of displayed, and a scope switch
 * resets all local work.
 */

import { scopedKey } from "./scopedAsync";
import type {
  WebsiteHandoverDraftScope,
  WebsiteHandoverRequestView,
} from "./types";

export type WebsiteHandoverReturnedView = Extract<
  WebsiteHandoverRequestView,
  { status: "returned" }
>;

export type WebsiteHandoverDraftState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "returned"; view: WebsiteHandoverReturnedView }
  | { status: "failed"; message: string };

export type WebsiteHandoverDownloadState =
  | {
      resourceId: string;
      status: "downloading" | "done" | "failed";
      message?: string;
    }
  | null;

export type WebsiteHandoverLocalState = {
  scopeKey: string;
  draft: WebsiteHandoverDraftState;
  download: WebsiteHandoverDownloadState;
  copied: boolean;
};

export function handoverScopeKey(scope: WebsiteHandoverDraftScope): string {
  return scopedKey(
    scope.jobId,
    scope.taskId,
    scope.channel,
    scope.approvedRevision,
    scope.approvedManifestSha256.toLowerCase(),
  );
}

export function draftScopesEqual(
  left: WebsiteHandoverDraftScope,
  right: WebsiteHandoverDraftScope,
): boolean {
  return handoverScopeKey(left) === handoverScopeKey(right);
}

export function createHandoverLocalState(
  scopeKey: string,
): WebsiteHandoverLocalState {
  return {
    scopeKey,
    draft: { status: "idle" },
    download: null,
    copied: false,
  };
}

export function beginHandoverDraftRequest(
  state: WebsiteHandoverLocalState,
): WebsiteHandoverLocalState {
  return { ...state, draft: { status: "requesting" } };
}

export function resolveHandoverDraftResponse(
  state: WebsiteHandoverLocalState,
  input: {
    requestedScope: WebsiteHandoverDraftScope;
    response: WebsiteHandoverRequestView;
  },
): WebsiteHandoverLocalState {
  const { requestedScope, response } = input;
  if (!draftScopesEqual(requestedScope, response.scope)) {
    return {
      ...state,
      draft: {
        status: "failed",
        message:
          "The prepared request was for a different job or version and was not shown.",
      },
    };
  }
  if (response.status === "failed") {
    return {
      ...state,
      draft: {
        status: "failed",
        message: response.error ?? "The access request could not be prepared.",
      },
    };
  }
  if (response.status === "requested") {
    return { ...state, draft: { status: "requesting" } };
  }
  if (!response.domain && !response.accessRequest) {
    return {
      ...state,
      draft: {
        status: "failed",
        message: "The prepared request came back empty and was not shown.",
      },
    };
  }
  return { ...state, draft: { status: "returned", view: response } };
}

export function failHandoverDraftRequest(
  state: WebsiteHandoverLocalState,
  message: string,
): WebsiteHandoverLocalState {
  return { ...state, draft: { status: "failed", message } };
}

export function beginHandoverDownload(
  state: WebsiteHandoverLocalState,
  resourceId: string,
): WebsiteHandoverLocalState {
  return {
    ...state,
    download: { resourceId, status: "downloading" },
  };
}

export function completeHandoverDownload(
  state: WebsiteHandoverLocalState,
  resourceId: string,
): WebsiteHandoverLocalState {
  if (state.download?.resourceId !== resourceId) return state;
  return { ...state, download: { resourceId, status: "done" } };
}

export function failHandoverDownload(
  state: WebsiteHandoverLocalState,
  resourceId: string,
  message: string,
): WebsiteHandoverLocalState {
  if (state.download?.resourceId !== resourceId) return state;
  return { ...state, download: { resourceId, status: "failed", message } };
}

export function markHandoverDraftCopied(
  state: WebsiteHandoverLocalState,
): WebsiteHandoverLocalState {
  return { ...state, copied: true };
}

export function clearHandoverDraftCopied(
  state: WebsiteHandoverLocalState,
): WebsiteHandoverLocalState {
  return { ...state, copied: false };
}
