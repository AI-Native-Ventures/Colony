/**
 * Letting the agent name the work it picked up.
 *
 * A chat-attributed Task is created before the agent's turn starts, so its
 * title is the raw message: `@Chief of Staff **find out and let me know about
 * the latest openclaw changes**`, mention prefix and markdown included. That
 * is a transcript line, not a name.
 *
 * The agent cannot rename it itself. `KIND_COMPANY_ACTION` is owner-only
 * (`buzz-relay/src/company_broker.rs`), and an agent has `MessagesWrite`, not
 * owner authority. What an agent CAN already write is a checkpoint summary
 * (`buzz jobs checkpoint --summary`), which is its own short account of the
 * work. So the agent names it, and the owner's app applies that name.
 *
 * This module only decides. The caller owns the relay write.
 */
import { MAX_TASK_TITLE_LEN } from "./newTaskModel";
import type { CompanyTask } from "./contracts";

/** Longest summary worth treating as a title rather than prose. */
const MAX_SUMMARY_WORDS = 14;

/**
 * Strip the composer's mention prefix and markdown so a raw-message title can
 * be recognised as one. Mirrors `impliesWork`'s normaliser in intent: role
 * names carry lowercase connectors, so the mention run continues through
 * those as well as capitalised words.
 */
function stripMessageChrome(value: string): string {
  return value
    .replace(
      /@[\w-]+(?:\s+(?:of|the|and|for|de|van|von|da|di)\b|\s+[A-Z][\w-]*)*/g,
      " ",
    )
    .replace(/[*_`~#>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether this task still carries the message it was minted from.
 *
 * Only an implicit (chat-attributed) task is ever renamed, and only while its
 * title is still that raw message. A title the owner typed in the New task
 * dialog, or one an agent already named, is left exactly as it is: silently
 * overwriting a human's words would be worse than an ugly title.
 */
export function carriesRawMessageTitle(
  task: Pick<CompanyTask, "implicit" | "title">,
  instruction: string | null,
): boolean {
  if (!task.implicit) return false;
  if (!instruction) return false;
  return stripMessageChrome(task.title) === stripMessageChrome(instruction);
}

/**
 * Turn a checkpoint summary into a title, or null when it is not one.
 *
 * A summary is prose written for a progress feed, so it is accepted only when
 * it already reads as a name: one line, present, and short. A rejected
 * summary leaves the raw-message title in place, which is honest - the task
 * keeps the words that created it rather than gaining a truncated paragraph.
 */
export function titleFromSummary(summary: string | null): string | null {
  if (!summary) return null;
  const firstLine = summary.split("\n")[0] ?? "";
  const cleaned = firstLine
    .replace(/[*_`~#>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return null;
  if (cleaned.split(" ").length > MAX_SUMMARY_WORDS) return null;
  if (cleaned.length > MAX_TASK_TITLE_LEN) return null;
  return cleaned;
}

/**
 * The title this task should take from this run, or null to leave it alone.
 *
 * Null is the common answer and is not a failure: the task was hand-named,
 * the agent has not checkpointed yet, its summary is prose, or the name it
 * proposes is what the task already says.
 */
export function agentTitleForTask(input: {
  task: Pick<CompanyTask, "implicit" | "title">;
  instruction: string | null;
  checkpointSummary: string | null;
}): string | null {
  if (!carriesRawMessageTitle(input.task, input.instruction)) return null;
  const title = titleFromSummary(input.checkpointSummary);
  if (!title) return null;
  if (title === input.task.title) return null;
  return title;
}
