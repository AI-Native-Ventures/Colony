import type { OpenAsk } from "@/features/asks/lib/askEvent";
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
  | "open-source"
  | "mark-done"
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
};

export type ActionMessageSource = {
  kind: "message";
  item: FeedItem;
  threadRootId: string | null;
  isDone: boolean;
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

export type ActionCenterProjectionInput = {
  asks: readonly OpenAsk[];
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
