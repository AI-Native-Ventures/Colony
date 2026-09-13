import type { CompanyProfile } from "@/features/company/contracts";
import { WELCOME_TEAM_ID } from "@/features/onboarding/welcomeGuide";
import type { ManagedAgentRuntimeStatus, RelayEvent } from "@/shared/api/types";

import type {
  ScoutSetupInput,
  ScoutSetupProof,
} from "../channelOnboarding/types";
import {
  assertScoutProfileAction,
  parseSignedScoutEvent,
  sameScoutSetupInput,
  snapshotScoutSetupInput,
  type ChannelOnboardingScope,
} from "../channelOnboardingSetup";
import type { ChannelOnboardingScope as StorageScope } from "../channelOnboardingStorage";

export type ScoutSetupAttemptPhase =
  | "profile-signed"
  | "profile-applied"
  | "team-ready"
  | "acknowledgement-signed"
  | "ready";

export type ScoutProfileReceipt = {
  receiptEventId: string;
  actionEventId: string;
  requestId: string;
  headEventId: string;
  target: string;
};

export type ScoutAcknowledgement = {
  eventId: string;
  signedEvent?: string;
  published?: boolean;
  receiptEventId?: string;
};

export function validAcknowledgement(
  value: unknown,
): value is ScoutAcknowledgement {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    value.eventId.trim() !== "" &&
    (value.signedEvent === undefined ||
      typeof value.signedEvent === "string") &&
    (value.published === undefined || typeof value.published === "boolean") &&
    (value.receiptEventId === undefined ||
      typeof value.receiptEventId === "string")
  );
}

export type ScoutRuntimeTeam = {
  agents: readonly {
    pubkey: string;
    name?: string;
    personaId?: string | null;
    teamId?: string | null;
  }[];
  alreadyStaffed?: boolean;
};

export type ScoutOnboardingAttempt = {
  version: 1;
  scope: ChannelOnboardingScope;
  approvalRequestId: string;
  input: ScoutSetupInput;
  rootEvent: RelayEvent;
  websiteState: "unknown" | "provided" | "none";
  relayPubkey: string;
  expectedHeadEventId: string;
  profile: CompanyProfile;
  signedProfileAction: string;
  profileActionEventId: string;
  profileReceipt: ScoutProfileReceipt | null;
  welcomeChannelId: string;
  scoutPubkey: string | null;
  runtimeStatus: ManagedAgentRuntimeStatus | null;
  acknowledgement: ScoutAcknowledgement | null;
  proof: ScoutSetupProof | null;
  phase: ScoutSetupAttemptPhase;
};

export type ScoutAttemptStore = {
  read(scope: StorageScope): ScoutOnboardingAttempt | null;
  write(scope: StorageScope, value: ScoutOnboardingAttempt): void;
  withLock<T>(scope: StorageScope, work: () => Promise<T>): Promise<T>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventShape(value: unknown): value is RelayEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.pubkey === "string" &&
    Number.isSafeInteger(value.created_at) &&
    Number.isSafeInteger(value.kind) &&
    Array.isArray(value.tags) &&
    value.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((part) => typeof part === "string"),
    ) &&
    typeof value.content === "string" &&
    typeof value.sig === "string"
  );
}

function validProfile(value: unknown): value is CompanyProfile {
  if (!isRecord(value)) return false;
  const serviceOk = (service: unknown) =>
    isRecord(service) &&
    typeof service.id === "string" &&
    typeof service.name === "string" &&
    (service.description === null || typeof service.description === "string");
  const costCentreOk = (centre: unknown) =>
    isRecord(centre) &&
    typeof centre.id === "string" &&
    typeof centre.name === "string" &&
    (centre.kind === "service" || centre.kind === "internal") &&
    (centre.serviceId === null || typeof centre.serviceId === "string");
  return (
    value.schema === "colony.company/v1" &&
    typeof value.tradingName === "string" &&
    (value.legalName === null || typeof value.legalName === "string") &&
    (value.website === null || typeof value.website === "string") &&
    (value.summary === null || typeof value.summary === "string") &&
    typeof value.businessType === "string" &&
    Array.isArray(value.services) &&
    value.services.every(serviceOk) &&
    Array.isArray(value.customerSegments) &&
    value.customerSegments.every((item) => typeof item === "string") &&
    Array.isArray(value.costCentres) &&
    value.costCentres.every(costCentreOk) &&
    (value.sourceReportEventId === null ||
      typeof value.sourceReportEventId === "string") &&
    Number.isSafeInteger(value.createdAt) &&
    Number.isSafeInteger(value.updatedAt)
  );
}

function validReceipt(value: unknown): value is ScoutProfileReceipt {
  return (
    isRecord(value) &&
    typeof value.receiptEventId === "string" &&
    typeof value.actionEventId === "string" &&
    typeof value.requestId === "string" &&
    typeof value.headEventId === "string" &&
    typeof value.target === "string"
  );
}

function profileTarget(relayPubkey: string) {
  return `30179:${relayPubkey}:profile`;
}

export function assertProfileReceiptForAttempt(
  receipt: ScoutProfileReceipt,
  attempt: ScoutOnboardingAttempt,
) {
  if (
    receipt.receiptEventId.trim() === "" ||
    receipt.actionEventId !== attempt.profileActionEventId ||
    receipt.requestId.toLowerCase() !==
      attempt.approvalRequestId.toLowerCase() ||
    receipt.target !== profileTarget(attempt.relayPubkey) ||
    receipt.headEventId.trim() === ""
  ) {
    throw new Error(
      "The saved company receipt belongs to a different Scout update. No setup was started.",
    );
  }
}

export function validAttempt(value: unknown): value is ScoutOnboardingAttempt {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!isRecord(value.scope) || !eventShape(value.rootEvent)) return false;
  if (!isRecord(value.input) || !validProfile(value.profile)) return false;
  if (
    typeof value.relayPubkey !== "string" ||
    typeof value.approvalRequestId !== "string" ||
    value.approvalRequestId.trim() === "" ||
    typeof value.expectedHeadEventId !== "string" ||
    typeof value.signedProfileAction !== "string" ||
    typeof value.profileActionEventId !== "string" ||
    (value.profileReceipt !== null && !validReceipt(value.profileReceipt)) ||
    typeof value.welcomeChannelId !== "string" ||
    (value.scoutPubkey !== null && typeof value.scoutPubkey !== "string") ||
    (value.runtimeStatus !== null && !isRecord(value.runtimeStatus)) ||
    (value.acknowledgement !== null && !isRecord(value.acknowledgement)) ||
    (value.proof !== null && !isRecord(value.proof)) ||
    !["unknown", "provided", "none"].includes(value.websiteState as string) ||
    ![
      "profile-signed",
      "profile-applied",
      "team-ready",
      "acknowledgement-signed",
      "ready",
    ].includes(value.phase as string)
  ) {
    return false;
  }
  try {
    snapshotScoutSetupInput(value.input as ScoutSetupInput);
  } catch {
    return false;
  }
  return true;
}

export function teamScout(team: ScoutRuntimeTeam) {
  if (!Array.isArray(team.agents) || team.agents.length !== 1) {
    throw new Error(
      "Scout setup stopped because Welcome returned more than the one approved Chief of Staff.",
    );
  }
  const [agent] = team.agents;
  if (
    !agent ||
    typeof agent.pubkey !== "string" ||
    agent.pubkey.trim() === ""
  ) {
    throw new Error("Scout setup did not return a usable Chief of Staff.");
  }
  if (agent.teamId !== undefined && agent.teamId !== WELCOME_TEAM_ID) {
    throw new Error("Scout setup returned an agent outside the Welcome team.");
  }
  return agent;
}

export function runtimeIsUsable(
  status: ManagedAgentRuntimeStatus,
  scoutPubkey: string,
  relayUrl: string,
) {
  return (
    status.pubkey.toLowerCase() === scoutPubkey.toLowerCase() &&
    status.relayUrl === relayUrl &&
    status.error === null &&
    status.lifecycle !== "failed" &&
    status.lifecycle !== "stopped"
  );
}

export function assertAttemptMatches(
  attempt: ScoutOnboardingAttempt,
  scope: ChannelOnboardingScope,
  input: ScoutSetupInput,
  root: RelayEvent,
) {
  if (
    attempt.scope.ownerPubkey.toLowerCase() !==
      scope.ownerPubkey.toLowerCase() ||
    attempt.scope.relayUrl !== scope.relayUrl ||
    attempt.scope.channelId !== scope.channelId ||
    attempt.scope.threadRootId !== scope.threadRootId ||
    attempt.scope.requestId !== scope.requestId ||
    !sameScoutSetupInput(attempt.input, input) ||
    attempt.rootEvent.id !== root.id ||
    attempt.rootEvent.pubkey !== root.pubkey ||
    attempt.rootEvent.created_at !== root.created_at ||
    attempt.rootEvent.kind !== root.kind ||
    JSON.stringify(attempt.rootEvent.tags) !== JSON.stringify(root.tags) ||
    attempt.rootEvent.content !== root.content ||
    attempt.rootEvent.sig !== root.sig
  ) {
    throw new Error(
      "The saved Scout setup belongs to a different approved snapshot. Review the original Welcome thread.",
    );
  }
}

export function assertSavedProfileAction(
  attempt: ScoutOnboardingAttempt,
  scope: ChannelOnboardingScope,
  input: ScoutSetupInput,
) {
  const action = parseSignedScoutEvent(attempt.signedProfileAction);
  if (action.id !== attempt.profileActionEventId) {
    throw new Error(
      "The saved Scout company update changed. No new update was sent.",
    );
  }
  assertScoutProfileAction(
    action,
    scope,
    input,
    attempt.profile,
    attempt.expectedHeadEventId,
    attempt.approvalRequestId,
    attempt.relayPubkey,
  );
}
