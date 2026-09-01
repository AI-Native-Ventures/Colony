/**
 * Pure validation for the "New task" form.
 *
 * `CompanyTask.title` is capped at 200 characters (`MAX_NAME_LEN` in
 * buzz-core), and the relay refuses anything longer. Checking it here means
 * a form filled out too long fails before a signed action is ever built,
 * not after.
 */

export const MAX_TASK_TITLE_LEN = 200;

export type NewTaskFormInput = {
  channelId: string;
  title: string;
  /**
   * The single persona accountable for this task. Required: a task created
   * with an empty assignee list lands on the coordination team with nobody
   * doing it, which is indistinguishable from a task that was never created.
   */
  assigneePersonaId: string;
  /** Personas to mention alongside the assignee. Nobody by default. */
  watcherPersonaIds?: readonly string[];
};

export type NewTaskValidation =
  | {
      ok: true;
      title: string;
      assigneePersonaId: string;
      watcherPersonaIds: string[];
    }
  | { ok: false; message: string };

/**
 * Validate and normalize a "New task" form submission.
 *
 * Channel is required with no fallback: `CompanyTask.source_channel_id` is
 * load-bearing for the job broker and the interrupt runtime, so there is no
 * safe default to guess when the caller has no channel in view.
 *
 * An assignee is required for the same class of reason: the planner accepts
 * an empty assignee list and the relay stores it, so nothing downstream ever
 * reports the task as unowned. It just never gets done.
 */
export function validateNewTaskInput(
  input: NewTaskFormInput,
): NewTaskValidation {
  if (!input.channelId) {
    return { ok: false, message: "Choose a channel for this task." };
  }
  const title = input.title.trim();
  if (!title) {
    return { ok: false, message: "Give this task a title." };
  }
  if (title.length > MAX_TASK_TITLE_LEN) {
    return {
      ok: false,
      message: `Title is too long (max ${MAX_TASK_TITLE_LEN} characters).`,
    };
  }
  if (!input.assigneePersonaId) {
    return { ok: false, message: "Choose who does this task." };
  }
  // A watcher who is also the assignee is already mentioned by the kickoff;
  // listing them twice would p-tag the same agent twice on one message.
  const watcherPersonaIds = [
    ...new Set(
      (input.watcherPersonaIds ?? []).filter(
        (personaId) => personaId && personaId !== input.assigneePersonaId,
      ),
    ),
  ];
  return {
    ok: true,
    title,
    assigneePersonaId: input.assigneePersonaId,
    watcherPersonaIds,
  };
}
