import type { OpenAsk } from "@/features/asks/lib/askEvent";
import type {
  AskResolution,
  ResolvedAsk,
} from "@/features/asks/lib/askResolution";
import type { BlockInstanceRef } from "@/features/blocks/contracts";
import type { CompanyTask } from "@/features/company/contracts";
import type { TaskRunHead } from "@/features/company/taskRunContracts";
import type { Reminder } from "@/features/reminders/lib/reminderTypes";
import type {
  FeedItem,
  Workflow,
  WorkflowApproval,
  WorkflowRun,
} from "@/shared/api/types";

export const ACTION_CENTER_FILTERS = [
  "needs-action",
  "all",
  "asks",
  "blocks",
  "tasks",
  "messages",
  "reminders",
  "workflows",
] as const;

export type ActionCenterFilter = (typeof ACTION_CENTER_FILTERS)[number];

export const ACTION_CENTER_STATES = [
  "open",
  "active",
  "completed",
  "failed",
] as const;

export type ActionCenterStateFilter = (typeof ACTION_CENTER_STATES)[number];

export type ActionItemKind =
  | "ask"
  | "block"
  | "task"
  | "message"
  | "reminder"
  | "workflow";

export type ActionItemState =
  | "needs-action"
  | "active"
  | "failed"
  | "completed";

export type ActionCapability =
  | "answer"
  /** Decide the item in place, without navigating to its channel. */
  | "decide-inline"
  | "open-source"
  | "mark-done"
  /**
   * Hide a row that is still unresolved at the relay. Distinct from
   * `mark-done`, which is only offered where nothing else is waiting on it.
   */
  | "hide-locally"
  | "undo-done"
  | "complete"
  | "snooze"
  | "cancel"
  | "open-details"
  | "open-workspace"
  | "approve"
  | "deny"
  | "run-again";

export type ActionAskSource = {
  kind: "ask";
  ask: OpenAsk;
  /**
   * The full resolution that closed this ask, set only on CLOSED rows.
   * Surfaces read `defaultExecuted` to mark an executed default (the relay
   * answered because the deadline passed with nobody answering) and must
   * never render it like an ordinary human answer.
   */
  resolution?: AskResolution;
};

export type ActionMessageSource = {
  kind: "message";
  item: FeedItem;
  threadRootId: string | null;
  isDone: boolean;
};

export type ActionBlockSource = {
  kind: "block";
  item: FeedItem;
  /** Parsed `block` / `block-data` / `block-attention` tags of the instance. */
  instance: BlockInstanceRef;
  threadRootId: string | null;
  isDone: boolean;
  /**
   * True only while the relay itself still counts this instance as unresolved:
   * the block declares `block-attention required` AND the relay returned it in
   * the needs-action feed, which already subtracts resolved receipts. The
   * client never re-decides this, so a locally hidden row and a relay-resolved
   * one stay tellable apart.
   */
  awaitingDecision: boolean;
};

export type ActionReminderSource = {
  kind: "reminder";
  reminder: Reminder;
};

export type ActionTaskSource = {
  kind: "task";
  task: CompanyTask;
  run: TaskRunHead | null;
  channelId: string | null;
  threadId: string | null;
};

export type ActionWorkflowSource = {
  kind: "workflow";
  workflow: Workflow;
  run: WorkflowRun;
  approval: WorkflowApproval | null;
};

export type ActionSource =
  | ActionAskSource
  | ActionBlockSource
  | ActionMessageSource
  | ActionReminderSource
  | ActionTaskSource
  | ActionWorkflowSource;

export type ActionItem = {
  id: string;
  kind: ActionItemKind;
  state: ActionItemState;
  title: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
  source: ActionSource;
  capabilities: readonly ActionCapability[];
};

export type ActionMessageItem = Omit<ActionItem, "kind" | "source"> & {
  kind: "message";
  source: ActionMessageSource;
};

export type ActionBlockItem = Omit<ActionItem, "kind" | "source"> & {
  kind: "block";
  source: ActionBlockSource;
};

export type ActionCenterProjectionInput = {
  asks: readonly OpenAsk[];
  /**
   * Asks already closed by a resolution, shown as completed rows so the
   * owner can see which of their asks were answered by people and which
   * were executed by silence. Absent means the surface reads no
   * resolutions.
   */
  resolvedAsks?: readonly ResolvedAsk[];
  /** Display labels for human resolvers, keyed by pubkey. */
  resolverLabelsByPubkey?: ReadonlyMap<string, string>;
  /**
   * Short routing phrases by ask id ("Auto-routed to the filer's
   * manager", ...). Absent means the summary stays as it was.
   */
  askRoutingNotesByAskId?: ReadonlyMap<string, string>;
  feed?: {
    mentions: readonly FeedItem[];
    needsAction: readonly FeedItem[];
    activity: readonly FeedItem[];
    agentActivity: readonly FeedItem[];
  };
  reminders: readonly Reminder[];
  tasks?: readonly ActionTaskSource[];
  workflows?: readonly ActionWorkflowSource[];
  doneIds?: ReadonlySet<string>;
};
