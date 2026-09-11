import type { CompanyTask, Initiative } from "@/features/company/contracts";
import {
  isTerminalTaskStatus,
  TASK_STATUSES,
} from "@/features/company/contracts";
import type { TaskArtifact } from "@/features/company/taskRunContracts";

/**
 * The tickets board's pure meaning: which of a community's tasks belong to
 * one project channel, which of three columns each one lands in, and how far
 * through the story they are.
 *
 * Scoping is by `sourceChannelId` - the channel a task was opened in. It is
 * the only link every task carries back to a channel: `threadRoot` is a
 * thread rather than a channel, `subject` describes what the work is about,
 * and `initiativeId` names an initiative whose own `sourceChannelId` is
 * usually the channel it was kicked off in, not the project's. A task whose
 * initiative is scoped to this channel is pulled in too, so kickoff work
 * filed against the initiative's channel still reads as this project's.
 *
 * Three columns, not eight statuses: the board is a story's progress, and a
 * per-status funnel of eight columns is unreadable in a tile. Terminal
 * statuses are done, live work (`inProgress`, `inReview`) is in progress, and
 * everything still waiting (`proposed`, `ready`, `blocked`, `snoozed`) is
 * todo.
 */

export const BOARD_COLUMN_KEYS = ["todo", "in-progress", "done"] as const;
export type BoardColumnKey = (typeof BOARD_COLUMN_KEYS)[number];

export const BOARD_COLUMN_LABELS: Record<BoardColumnKey, string> = {
  done: "Done",
  "in-progress": "In progress",
  todo: "Todo",
};

const IN_PROGRESS_STATUSES = ["inProgress", "inReview"] as const;

export type BoardColumn = {
  key: BoardColumnKey;
  label: string;
  statuses: string[];
  tasks: CompanyTask[];
};

export type BoardProjection = {
  initiative: Initiative | null;
  columns: BoardColumn[];
  progress: { done: number; total: number };
};

/** Which of the three columns a status belongs to. */
export function boardColumnForStatus(status: string): BoardColumnKey {
  if (isTerminalTaskStatus(status as CompanyTask["status"])) return "done";
  return (IN_PROGRESS_STATUSES as readonly string[]).includes(status)
    ? "in-progress"
    : "todo";
}

function statusesFor(key: BoardColumnKey): string[] {
  return TASK_STATUSES.filter((status) => boardColumnForStatus(status) === key);
}

/**
 * A task belongs to this board when it was opened in this channel, or when
 * the initiative it belongs to was.
 */
export function isProjectTask(
  task: CompanyTask,
  channelId: string,
  initiativeChannelById: ReadonlyMap<string, string>,
): boolean {
  if (task.hidden) return false;
  if (task.sourceChannelId === channelId) return true;
  if (task.initiativeId === null) return false;
  return initiativeChannelById.get(task.initiativeId) === channelId;
}

/**
 * The initiative this board tells the story of: the one most of this
 * channel's tasks belong to. Ties break on id so the header does not flip
 * between two equally-sized initiatives across refetches.
 */
function dominantInitiative(
  tasks: readonly CompanyTask[],
  initiatives: readonly Initiative[],
): Initiative | null {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.initiativeId === null) continue;
    counts.set(task.initiativeId, (counts.get(task.initiativeId) ?? 0) + 1);
  }
  let winner: Initiative | null = null;
  let winningCount = 0;
  for (const initiative of initiatives) {
    const count = counts.get(initiative.id) ?? 0;
    if (count === 0) continue;
    if (
      count > winningCount ||
      (count === winningCount &&
        winner !== null &&
        initiative.id.localeCompare(winner.id) < 0)
    ) {
      winner = initiative;
      winningCount = count;
    }
  }
  return winner;
}

/** Newest-updated first inside a column, ties settled on id. */
function boardOrder(left: CompanyTask, right: CompanyTask): number {
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
}

export function projectBoard(input: {
  tasks: readonly CompanyTask[];
  initiatives: readonly Initiative[];
  channelId: string;
}): BoardProjection {
  const initiativeChannelById = new Map(
    input.initiatives.map((initiative) => [
      initiative.id,
      initiative.sourceChannelId,
    ]),
  );
  const scoped = input.tasks.filter((task) =>
    isProjectTask(task, input.channelId, initiativeChannelById),
  );
  const columns = BOARD_COLUMN_KEYS.map((key) => ({
    key,
    label: BOARD_COLUMN_LABELS[key],
    statuses: statusesFor(key),
    tasks: scoped
      .filter((task) => boardColumnForStatus(task.status) === key)
      .sort(boardOrder),
  }));
  const done =
    columns.find((column) => column.key === "done")?.tasks.length ?? 0;
  return {
    initiative: dominantInitiative(scoped, input.initiatives),
    columns,
    progress: { done, total: scoped.length },
  };
}

/** Every assignee on the board, in first-seen order. */
export function boardAssigneeIds(board: BoardProjection): string[] {
  const seen: string[] = [];
  for (const column of board.columns) {
    for (const task of column.tasks) {
      for (const assignee of task.assigneePersonaIds) {
        if (!seen.includes(assignee)) seen.push(assignee);
      }
    }
  }
  return seen;
}

const PULL_REQUEST_PATH = /\/(?:pull|pull-requests|merge_requests)\/\d+/;

/**
 * The pull request this task delivered, when it has one.
 *
 * A run's `url` artifacts are the first place to look - that is where an
 * agent files what it produced. A task whose subject is an external
 * reference can also name one directly, which is how work filed against a PR
 * rather than producing one still links.
 */
export function taskPullRequestUrl(
  task: Pick<CompanyTask, "subject">,
  artifacts: readonly TaskArtifact[] = [],
): string | null {
  for (const artifact of artifacts) {
    if (artifact.kind !== "url") continue;
    if (PULL_REQUEST_PATH.test(artifact.reference)) return artifact.reference;
  }
  if (
    task.subject?.kind === "external" &&
    PULL_REQUEST_PATH.test(task.subject.ref)
  ) {
    return task.subject.ref;
  }
  return null;
}

/** `https://github.com/o/r/pull/12` → `#12`, for a chip that must stay short. */
export function pullRequestLabel(url: string): string {
  const match = url.match(/\/(?:pull|pull-requests|merge_requests)\/(\d+)/);
  return match ? `#${match[1]}` : "PR";
}

/** Two-letter initials for an avatar chip: `horizonlabs:sales-lead` → `SL`. */
export function assigneeInitials(personaId: string): string {
  const tail = personaId.slice(
    Math.max(personaId.lastIndexOf(":"), personaId.lastIndexOf("/")) + 1,
  );
  const source = (tail === "" ? personaId : tail).replace(
    /[^a-zA-Z0-9]+/g,
    " ",
  );
  const words = source.split(" ").filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
