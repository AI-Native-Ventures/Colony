/**
 * Pure state transitions for the owner decision panel.
 *
 * All local panel state is scoped to `channel:job:task:actor`. Switching to a
 * different job or viewer produces a fresh state object, and an async dispatch
 * may only commit its result while its own scope is still current, so a late
 * result from a previous job can never decorate a newer card.
 */

import type { WebsitePendingDecision } from "./reviewLogic";
import type {
  WebsiteDecisionReceipt,
  WebsiteDecisionRequest,
} from "./types";

export type WebsiteDecisionFailure = {
  message: string;
  /** The exact payload a retry would resend; absent for local validation. */
  request?: WebsiteDecisionRequest;
  conflict: boolean;
};

export type WebsiteDecisionPanelState = {
  scopeKey: string;
  note: string;
  pending: WebsitePendingDecision | null;
  failed: WebsiteDecisionFailure | null;
  receipt: WebsiteDecisionReceipt | null;
};

export function decisionScopeKey(input: {
  channel: string;
  jobId: string;
  taskId: string;
  actor: string;
}): string {
  return [input.channel, input.jobId, input.taskId, input.actor].join("\u0000");
}

export function createDecisionPanelState(
  scopeKey: string,
): WebsiteDecisionPanelState {
  return {
    scopeKey,
    note: "",
    pending: null,
    failed: null,
    receipt: null,
  };
}

/** Reset local state in place when the panel is bound to a different scope. */
export function withDecisionScope(
  state: WebsiteDecisionPanelState,
  scopeKey: string,
): WebsiteDecisionPanelState {
  return state.scopeKey === scopeKey
    ? state
    : createDecisionPanelState(scopeKey);
}

export function setDecisionNote(
  state: WebsiteDecisionPanelState,
  note: string,
): WebsiteDecisionPanelState {
  return { ...state, note };
}

export function beginDecisionDispatch(
  state: WebsiteDecisionPanelState,
  pending: WebsitePendingDecision,
): WebsiteDecisionPanelState {
  return { ...state, failed: null, receipt: null, pending };
}

export function confirmDecisionReceipt(
  state: WebsiteDecisionPanelState,
  receipt: WebsiteDecisionReceipt,
): WebsiteDecisionPanelState {
  return { ...state, receipt };
}

export function failDecisionDispatch(
  state: WebsiteDecisionPanelState,
  failure: WebsiteDecisionFailure,
): WebsiteDecisionPanelState {
  return { ...state, pending: null, receipt: null, failed: failure };
}

export function completeDecisionDispatch(
  state: WebsiteDecisionPanelState,
): WebsiteDecisionPanelState {
  return {
    ...state,
    pending: null,
    receipt: null,
    failed: null,
    note: "",
  };
}

export function clearDecisionFailure(
  state: WebsiteDecisionPanelState,
): WebsiteDecisionPanelState {
  return { ...state, failed: null };
}

/**
 * True when an async dispatch started under `dispatchScope` may still commit.
 * A resolved result for any other (older) scope is discarded.
 */
export function isDispatchCurrent(
  dispatchScope: string,
  currentScope: string,
): boolean {
  return dispatchScope === currentScope;
}
