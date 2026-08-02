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
