/**
 * Pure state for the brief start action. The component scopes it to the exact
 * job/task/channel and guards async results with `isScopeCurrent`, so a start
 * dispatched for one job never leaves a waiting or error state on another.
 */

import { scopedKey } from "./scopedAsync";
import type { WebsiteStartRequest } from "./types";

export type WebsiteBriefStartState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "waiting" }
  | { status: "failed"; message: string };

export function briefScopeKey(request: WebsiteStartRequest): string {
  return scopedKey(request.jobId, request.taskId, request.channel);
}

export function createBriefStartState(): WebsiteBriefStartState {
  return { status: "idle" };
}

export function beginBriefStart(): WebsiteBriefStartState {
  return { status: "starting" };
}

export function awaitBriefConfirmation(): WebsiteBriefStartState {
  return { status: "waiting" };
}

export function failBriefStart(message: string): WebsiteBriefStartState {
  return { status: "failed", message };
}
