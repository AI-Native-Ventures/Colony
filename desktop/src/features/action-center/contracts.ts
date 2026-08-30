import type { OpenAsk } from "@/features/asks/lib/askEvent";
import type {
  AskResolution,
  ResolvedAsk,
} from "@/features/asks/lib/askResolution";
import type { BlockInstanceRef } from "@/features/blocks/contracts";
import type { Reminder } from "@/features/reminders/lib/reminderTypes";
import type { ThreadPing } from "./lib/threadPings";
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

export type ActionItemKind = "ask" | "block" | "reminder" | "workflow" | "ping";

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
  | "run-again"
  /**
   * Dismisses a thread ping by publishing a kind:7 reaction on it -- distinct
   * from `mark-done`, which this epic's v2 queue no longer backs with any
   * local state (see ranked-queue-model). A dismissed ping's "done" state
   * lives entirely at the relay, not here.
   */
  | "dismiss";

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
  /**
   * The deadline computed exactly as the broker does (see
   * `lib/askDeadline.ts`), for the countdown UI a later ticket renders.
   * Only meaningful (drives an auto-execution) when `ask.defaultOption` is
   * set, but computed for every ask row for a uniform contract.
   */
  deadlineAt: number;
  /**
   * `ask.category` matched case-insensitively against the hard list (spend,
   * external_send, hiring, legal, pricing, deletion, vendor) — categories
   * that can never carry a default-on-timeout and so wait on the owner
   * forever. `false` when the ask carries no category.
   */
  isHardList: boolean;
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

export type ActionWorkflowSource = {
  kind: "workflow";
  workflow: Workflow;
  run: WorkflowRun;
  approval: WorkflowApproval | null;
};

export type ActionPingSource = {
  kind: "ping";
  ping: ThreadPing;
};

export type ActionSource =
  | ActionAskSource
  | ActionBlockSource
  | ActionReminderSource
  | ActionWorkflowSource
  | ActionPingSource;

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
  /**
   * Only the `needsAction` home-feed category is read here. `mentions`,
   * `activity`, and `agentActivity` fed a generic "message" row that is not
   * an actionable item under the v2 queue model (Home is where those live
   * now); `needsAction` survives because it is also where Block instances
   * awaiting a decision are found.
   */
  feed?: {
    needsAction: readonly FeedItem[];
  };
  reminders: readonly Reminder[];
  workflows?: readonly ActionWorkflowSource[];
  /**
   * Unanswered thread pings, already detected and suppression-checked (see
   * `lib/threadPings.ts`, `useThreadPings`). Absent means the surface reads
   * no pings, same convention as `workflows`.
   */
  pings?: readonly ThreadPing[];
  doneIds?: ReadonlySet<string>;
  /** Unix seconds used to decide which reminders are due. Defaults to now;
   * overridable so tests can pin the clock. */
  now?: number;
  /**
   * The community's `ask_window_secs` override (kind 30179 content), or
   * `null` when there is none yet — see `lib/companyAskWindow.ts`. Feeds
   * every ask's computed deadline (tier 1 ranking).
   */
  companyAskWindowSecs?: number | null;
};
