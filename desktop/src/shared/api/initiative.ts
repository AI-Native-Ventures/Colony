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

/** The Task an agent-directed message will be charged to. */
export type ChatTaskResult = {
  taskId: string;
  owningTeamId: string;
  /** The signed Company Action that creates it. */
  signedAction: string;
};

export type EnsureChatTaskInput = {
  /** The relay-signed company head, exactly as it was read. */
  companyHead: string;
  channelId: string;
  /** This client's stable identity for this send. A retry reuses it. */
  sendId: string;
  agentPubkey: string;
  title: string;
  clientOrganizationId: string | null;
  relayPubkey: string;
};

export async function ensureChatTask(
  input: EnsureChatTaskInput,
): Promise<ChatTaskResult> {
  return await invokeTauri<ChatTaskResult>("ensure_chat_task", {
    companyHead: input.companyHead,
    channelId: input.channelId,
    sendId: input.sendId,
    agentPubkey: input.agentPubkey,
    title: input.title,
    clientOrganizationId: input.clientOrganizationId,
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
