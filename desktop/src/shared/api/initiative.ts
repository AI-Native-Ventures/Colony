import { invokeTauri } from "./tauri";

/**
 * Starting or declining an initiative.
 *
 * The backend holds the owner's signing key and the rule for what may be
 * published; this asks it what to publish next. The split matters: the Company
 * Action envelope has a canonical encoding the relay validates exactly, and a
 * second implementation of it in TypeScript would agree in every test and
 * diverge on the first real input.
 */
export type InitiativeStepResult = {
  initiativeId: string;
  /** The status the head carried when the step was decided. */
  status: string;
  /** What publishing the action makes it, when the step is a transition. */
  nextStatus: string | null;
  /** The Task this creates, when the initiative is already active. */
  taskId: string | null;
  owningTeamId: string | null;
  /** The signed Company Action to publish, or null when nothing is left. */
  signedAction: string | null;
  /** Whether nothing further has to be published after this one. */
  settled: boolean;
};

export type AdvanceInitiativeInput = {
  /** The relay-signed company head, exactly as it was read. */
  companyHead: string;
  /** The relay-signed initiative head, exactly as it was read. */
  initiativeHead: string;
  relayPubkey: string;
  intent: "start" | "decline";
};

export async function advanceInitiative(
  input: AdvanceInitiativeInput,
): Promise<InitiativeStepResult> {
  return await invokeTauri<InitiativeStepResult>("advance_initiative", {
    companyHead: input.companyHead,
    initiativeHead: input.initiativeHead,
    relayPubkey: input.relayPubkey,
    intent: input.intent,
  });
}

/**
 * What a send asks its thread for.
 *
 * `open` says the message implies work: attach to the thread's open task, or
 * open one titled with this instruction. `attach` says it does not: join the
 * open task if there is one, otherwise the hidden chat task, so the turn is
 * still charged without putting "are you there?" on the Tasks page. `new` is
 * the composer's explicit second task in a thread that already has one.
 */
export type ThreadAttachMode = "open" | "attach" | "new";

/** The signed question one send asks about which Task it belongs to. */
export type ThreadAttachResult = {
  /** The signed Company Action to publish. */
  signedAction: string;
};

export type AttachThreadTaskInput = {
  channelId: string;
  /** This client's stable identity for this send. A retry reuses it. */
  sendId: string;
  /** Agent this send names, `null` when it names none. */
  agentPubkey: string | null;
  title: string;
  mode: ThreadAttachMode;
  /**
   * Root event id of the thread this send replies in, `null` at channel root.
   * A send that starts its own thread is claimed under its `sendId` instead,
   * and the relay rebinds that claim onto the real root once the message
   * arrives.
   */
  threadRoot: string | null;
  /** True for a DM, where the conversation itself is the thread. */
  conversationScope: boolean;
  clientOrganizationId?: string | null;
  /** Parent task, when this send opens a sub-task under one. */
  parentTaskId?: string | null;
  relayPubkey: string;
};

/**
 * Ask the relay which Task this send is charged to.
 *
 * The client proposes no task id. Two devices preparing the same send would
 * each read "this thread has no open task" and each create one, so the
 * decision belongs where there is exactly one copy of the answer.
 */
export async function attachThreadTask(
  input: AttachThreadTaskInput,
): Promise<ThreadAttachResult> {
  return await invokeTauri<ThreadAttachResult>("attach_thread_task", {
    channelId: input.channelId,
    sendId: input.sendId,
    agentPubkey: input.agentPubkey,
    title: input.title,
    mode: input.mode,
    threadRoot: input.threadRoot,
    conversationScope: input.conversationScope,
    clientOrganizationId: input.clientOrganizationId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    relayPubkey: input.relayPubkey,
  });
}

/** The Task a human created directly, e.g. from a "New Task" affordance. */
export type UserTaskResult = {
  taskId: string;
  owningTeamId: string;
  /** The signed Company Action that creates it. */
  signedAction: string;
};

export type CreateUserTaskInput = {
  /** The relay-signed company head, exactly as it was read. */
  companyHead: string;
  /**
   * This client's stable identity for this create attempt. A retry (a lost
   * receipt) reuses it and asks for the same Task; two attempts sharing every
   * other field, including title, still need distinct ids here to become two
   * Tasks - mint a fresh one (e.g. `crypto.randomUUID()`) per "create" click,
   * not per title.
   */
  requestId: string;
  /**
   * Home channel the Task's work happens and is discussed in. Required -
   * there is no company-wide default the backend can safely fall back to.
   */
  channelId: string;
  title: string;
  /** Defaults to the company's coordination team when omitted. */
  owningTeamId?: string | null;
  /** Defaults to the company's internal cost centre when omitted. */
  costCentreId?: string | null;
  /** The relay-signed initiative head, when this Task belongs to one. */
  initiativeHead?: string | null;
  assigneePersonaIds?: string[];
  clientOrganizationId?: string | null;
  relayPubkey: string;
};

export async function createUserTask(
  input: CreateUserTaskInput,
): Promise<UserTaskResult> {
  return await invokeTauri<UserTaskResult>("create_user_task", {
    companyHead: input.companyHead,
    requestId: input.requestId,
    channelId: input.channelId,
    title: input.title,
    owningTeamId: input.owningTeamId ?? null,
    costCentreId: input.costCentreId ?? null,
    initiativeHead: input.initiativeHead ?? null,
    assigneePersonaIds: input.assigneePersonaIds ?? [],
    clientOrganizationId: input.clientOrganizationId ?? null,
    relayPubkey: input.relayPubkey,
  });
}

/** The Initiative a human created directly, e.g. from a "New initiative"
 * affordance. */
export type UserInitiativeResult = {
  initiativeId: string;
  /** The persona the initiative is accountable to. */
  ownerPersonaId: string;
  /** The signed Company Action that creates it. */
  signedAction: string;
};

export type CreateInitiativeInput = {
  /** The relay-signed company head, exactly as it was read. */
  companyHead: string;
  /**
   * This client's stable identity for this create attempt. A retry (a lost
   * receipt) reuses it and asks for the same initiative; two attempts sharing
   * every other field, including title, still need distinct ids here to become
   * two initiatives - mint a fresh one (e.g. `crypto.randomUUID()`) per
   * "create" click, not per title.
   */
  requestId: string;
  /** Channel the initiative was raised in. Required: the contract has no
   * company-wide default for it. */
  channelId: string;
  title: string;
  /** Free text. Absent and empty mean the same thing. */
  summary?: string | null;
  /** Defaults to the company's internal cost centre when omitted. */
  costCentreId?: string | null;
  clientOrganizationId?: string | null;
  relayPubkey: string;
};

/**
 * Create an initiative as `proposed`.
 *
 * Describing work is not starting it: the returned action creates a proposed
 * initiative, and starting it is a separate owner decision through
 * {@link advanceInitiative}.
 */
export async function createInitiative(
  input: CreateInitiativeInput,
): Promise<UserInitiativeResult> {
  return await invokeTauri<UserInitiativeResult>("create_initiative", {
    companyHead: input.companyHead,
    requestId: input.requestId,
    channelId: input.channelId,
    title: input.title,
    summary: input.summary ?? null,
    costCentreId: input.costCentreId ?? null,
    clientOrganizationId: input.clientOrganizationId ?? null,
    relayPubkey: input.relayPubkey,
  });
}
