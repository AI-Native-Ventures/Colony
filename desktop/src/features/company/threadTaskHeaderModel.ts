import type { CompanyTask } from "./contracts";

/**
 * What the thread panel's header says about the work open in the thread.
 *
 * Pure on purpose: the header owns layout, this owns the rule, and the rule
 * is the part worth proving without rendering anything.
 */

export type ThreadTaskHeader = {
  /** The open task's title, or `null` when the thread has no work open. */
  title: string | null;
  /** Whether this viewer may close the task from here. */
  canMarkDone: boolean;
};

/**
 * "Mark done" is the owner's close, not an assignee's report.
 *
 * An agent finishing its own share publishes a completion report and the task
 * closes on its own once every assignee has. A Company Action may only be
 * signed by the human owner, so a member who is known not to be one is not
 * offered a button the relay is going to refuse.
 *
 * An unknown role is not a refusal. A relay that does not advertise NIP-43
 * membership reports no role for anybody, which is the ordinary single-owner
 * install: hiding the control there would take it away from the only person
 * who could ever use it.
 *
 * A hidden task is never offered either: it exists to carry the cost of turns
 * that were not work, and there is nothing in it for a member to finish.
 */
export function threadTaskHeader(
  openTask: CompanyTask | null,
  viewerRole: string | null | undefined,
): ThreadTaskHeader {
  if (!openTask || openTask.hidden) return { title: null, canMarkDone: false };
  const known = viewerRole !== null && viewerRole !== undefined;
  return {
    title: openTask.title,
    canMarkDone: !known || viewerRole === "owner",
  };
}
