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
};

export type NewTaskValidation =
  | { ok: true; title: string }
  | { ok: false; message: string };

/**
 * Validate and normalize a "New task" form submission.
 *
 * Channel is required with no fallback: `CompanyTask.source_channel_id` is
 * load-bearing for the job broker and the interrupt runtime, so there is no
 * safe default to guess when the caller has no channel in view.
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
  return { ok: true, title };
}
