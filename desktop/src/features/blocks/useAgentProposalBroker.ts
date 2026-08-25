import * as React from "react";
import { verifyEvent } from "nostr-tools/pure";

import {
  type AgentProposalData,
  type AgentProposalInstance,
  type AgentProposalReceiptResult,
  type AgentProposalSafeAction,
  parseAgentProposalData,
  parseAgentProposalDecline,
  parseAgentProposalSafeAction,
} from "@/features/blocks/agentProposal";
import { canonicalBlockJson } from "@/features/blocks/blockActions";
import {
  parseBlockAction,
  parseBlockInstance,
  parseBlockReceipt,
} from "@/features/blocks/blockTags";
import { useChannelsQuery } from "@/features/channels/hooks";
import {
  useManagedAgentsQuery,
  usePersonasQuery,
} from "@/features/agents/hooks";
import { executeAgentProposal } from "@/shared/api/agentProposals";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import type {
  AgentPersona,
  Channel,
  ManagedAgent,
  RelayEvent,
} from "@/shared/api/types";
import {
  KIND_BLOCK_ACTION,
  KIND_BLOCK_RECEIPT,
  KIND_STREAM_MESSAGE,
} from "@/shared/constants/kinds";
import { useIdentityQuery } from "@/shared/api/hooks";

const ACKNOWLEDGED_ACTION_EVENT =
  "ai-native-office:agent-proposal-action-acknowledged";

type AgentProposalExecutionQueue = {
  actions: Map<string, Promise<unknown>>;
  resolved: boolean;
  tail: Promise<void>;
};

export type AgentProposalProcessOutcome = "complete" | "retry" | "ignored";

const AGENT_PROPOSAL_RETRY_INITIAL_MS = 250;
const AGENT_PROPOSAL_RETRY_MAX_MS = 5_000;

function agentProposalRetryDelay(attempt: number) {
  return Math.min(
    AGENT_PROPOSAL_RETRY_INITIAL_MS * 2 ** attempt,
    AGENT_PROPOSAL_RETRY_MAX_MS,
  );
}

function waitForAgentProposalRetry(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function processAgentProposalActionUntilTerminal(input: {
  isActive: () => boolean;
  operation: () => Promise<AgentProposalProcessOutcome>;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<AgentProposalProcessOutcome | "stopped"> {
  const wait = input.wait ?? waitForAgentProposalRetry;
  let attempt = 0;
  while (input.isActive()) {
    let outcome: AgentProposalProcessOutcome;
    try {
      outcome = await input.operation();
    } catch {
      outcome = "retry";
    }
    if (outcome !== "retry") return outcome;
    await wait(agentProposalRetryDelay(attempt));
    attempt += 1;
  }
  return "stopped";
}

type AgentProposalCommunityLease = {
  executionScope: string;
  relayUrl: string;
  generation: number;
};

// Process-lifetime, cryptographically scoped execution queues. They are
// intentionally not cleared by query refreshes or relay reconnects: a
// replacement effect joins the same per-proposal queue while IPC is pending.
const agentProposalExecutions = new Map<string, AgentProposalExecutionQueue>();
// A browser CustomEvent is edge-triggered. Query refreshes can briefly unmount
// the broker between publishing an action and receiving its event, so retain
// locally acknowledged actions until an owner receipt is actually accepted.
const acknowledgedAgentProposalActions = new Map<
  string,
  AcknowledgedAgentProposalAction
>();
let activeAgentProposalCommunityLease: AgentProposalCommunityLease | null =
  null;
let nextAgentProposalCommunityGeneration = 1;

function activateAgentProposalCommunity(
  executionScope: string,
  relayUrl: string,
) {
  const lease = {
    executionScope,
    relayUrl,
    generation: nextAgentProposalCommunityGeneration++,
  };
  activeAgentProposalCommunityLease = lease;
  return lease;
}

function deactivateAgentProposalCommunity(lease: AgentProposalCommunityLease) {
  if (activeAgentProposalCommunityLease === lease) {
    activeAgentProposalCommunityLease = null;
  }
}

function isCurrentAgentProposalCommunity(lease: AgentProposalCommunityLease) {
  return activeAgentProposalCommunityLease === lease;
}

export function agentProposalExecutionKey(input: {
  ownerPubkey: string;
  communityExecutionScope: string;
  instanceEventId: string;
}) {
  return JSON.stringify([
    normalize(input.ownerPubkey),
    input.communityExecutionScope,
    input.instanceEventId,
  ]);
}

export function runAgentProposalActionOnce<T>(
  proposalKey: string,
  actionEventId: string,
  operation: () => Promise<T>,
  resolvesProposal: (result: T) => boolean = () => false,
): Promise<T | null> {
  const existingQueue = agentProposalExecutions.get(proposalKey);
  const existingAction = existingQueue?.actions.get(actionEventId);
  if (existingAction) return existingAction as Promise<T | null>;

  const queue = existingQueue ?? {
    actions: new Map<string, Promise<unknown>>(),
    resolved: false,
    tail: Promise.resolve(),
  };
  const execute = async () => {
    if (queue.resolved) return null;
    const result = await operation();
    if (resolvesProposal(result)) {
      queue.resolved = true;
    }
    return result;
  };
  const pending = queue.tail.then(execute, execute).finally(() => {
    if (queue.actions.get(actionEventId) === pending) {
      queue.actions.delete(actionEventId);
    }
    if (
      queue.actions.size === 0 &&
      agentProposalExecutions.get(proposalKey) === queue
    ) {
      agentProposalExecutions.delete(proposalKey);
    }
  });
  queue.actions.set(actionEventId, pending);
  queue.tail = pending.then(
    () => undefined,
    () => undefined,
  );
  agentProposalExecutions.set(proposalKey, queue);
  return pending;
}

export type AcknowledgedAgentProposalAction = {
  event: RelayEvent;
  backendConfig?: Record<string, unknown>;
};

type AgentProposalAuthorityContext = {
  ownerPubkey: string;
  managedAgents: readonly Pick<ManagedAgent, "pubkey">[];
  channels: readonly Pick<Channel, "id" | "isMember" | "memberPubkeys">[];
  personas: readonly Pick<
    AgentPersona,
    "id" | "displayName" | "isBuiltIn" | "sourceTeam"
  >[];
};

type ValidatedAgentProposalAction =
  | {
      kind: "execute";
      actionId: "agent.create" | "agent.update";
      action: AgentProposalSafeAction;
      proposal: AgentProposalInstance;
      idempotencyKey: string;
    }
  | {
      kind: "decline";
      actionId: "agent.decline";
      proposal: AgentProposalInstance;
      idempotencyKey: string;
    };

function tagsNamed(event: RelayEvent, name: string) {
  return event.tags.filter((tag) => tag[0] === name);
}

function exactChannelId(event: RelayEvent): string | null {
  const tags = tagsNamed(event, "h");
  return tags.length === 1 && tags[0]?.length === 2
    ? (tags[0]?.[1] ?? null)
    : null;
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function eventVerifies(event: RelayEvent) {
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

function editableDefinitionId(
  proposal: AgentProposalData,
  personas: AgentProposalAuthorityContext["personas"],
) {
  if (proposal.mode !== "update") return undefined;
  const target = normalize(proposal.agentName);
  const matches = personas.filter(
    (persona) =>
      normalize(persona.displayName) === target &&
      !persona.isBuiltIn &&
      !persona.sourceTeam,
  );
  return matches.length === 1 ? matches[0]?.id : undefined;
}

export function validateAgentProposalActionContext(input: {
  actionEvent: RelayEvent;
  instanceEvent: RelayEvent;
  context: AgentProposalAuthorityContext;
}): ValidatedAgentProposalAction | null {
  const { actionEvent, instanceEvent, context } = input;
  const ownerPubkey = normalize(context.ownerPubkey);
  if (
    actionEvent.kind !== KIND_BLOCK_ACTION ||
    instanceEvent.kind !== KIND_STREAM_MESSAGE ||
    normalize(actionEvent.pubkey) !== ownerPubkey ||
    !eventVerifies(actionEvent) ||
    !eventVerifies(instanceEvent)
  ) {
    return null;
  }
  const ownerTags = tagsNamed(actionEvent, "p");
  if (
    ownerTags.length !== 1 ||
    ownerTags[0]?.length !== 2 ||
    normalize(ownerTags[0]?.[1] ?? "") !== ownerPubkey
  ) {
    return null;
  }
  const actionRef = parseBlockAction(actionEvent.tags);
  const instanceRef = parseBlockInstance(instanceEvent.tags);
  if (!actionRef.ok || !instanceRef.ok) return null;
  const actionChannelId = exactChannelId(actionEvent);
  const instanceChannelId = exactChannelId(instanceEvent);
  if (
    !actionChannelId ||
    actionChannelId !== instanceChannelId ||
    actionRef.value.instanceEventId !== instanceEvent.id ||
    actionRef.value.instanceId !== instanceRef.value.instanceId ||
    actionRef.value.manifestId !== instanceRef.value.manifestId ||
    normalize(actionRef.value.processorPubkey) !== ownerPubkey ||
    instanceRef.value.handle !== "agent-proposal" ||
    !instanceRef.value.attentionRequired ||
    normalize(instanceRef.value.decisionMakerPubkey ?? "") !== ownerPubkey ||
    instanceRef.value.data.type !== "inline"
  ) {
    return null;
  }
  const proposalData = parseAgentProposalData(
    instanceRef.value.data.value,
    instanceRef.value.instanceId,
  );
  if (!proposalData || proposalData.channelId !== instanceChannelId)
    return null;

  const signerPubkey = normalize(instanceEvent.pubkey);
  const signerIsOwned = context.managedAgents.some(
    (agent) => normalize(agent.pubkey) === signerPubkey,
  );
  const channel = context.channels.find(
    (candidate) => candidate.id === instanceChannelId,
  );
  if (
    !signerIsOwned ||
    !channel?.isMember ||
    !channel.memberPubkeys.some(
      (memberPubkey) => normalize(memberPubkey) === signerPubkey,
    )
  ) {
    return null;
  }

  const proposal: AgentProposalInstance = {
    event: instanceEvent,
    channelId: instanceChannelId,
    signerPubkey,
    manifestId: instanceRef.value.manifestId,
    instanceId: instanceRef.value.instanceId,
    processorPubkey: ownerPubkey,
    data: proposalData,
  };
  let content: unknown;
  try {
    content = JSON.parse(actionEvent.content);
  } catch {
    return null;
  }

  if (actionRef.value.actionId === "agent.decline") {
    return parseAgentProposalDecline(content, proposalData)
      ? {
          kind: "decline",
          actionId: "agent.decline",
          proposal,
          idempotencyKey: actionRef.value.idempotencyKey,
        }
      : null;
  }
  if (
    (actionRef.value.actionId !== "agent.create" ||
      proposalData.mode !== "create") &&
    (actionRef.value.actionId !== "agent.update" ||
      proposalData.mode !== "update")
  ) {
    return null;
  }
  const expectedDefinitionId = editableDefinitionId(
    proposalData,
    context.personas,
  );
  if (proposalData.mode === "update" && !expectedDefinitionId) return null;
  const action = parseAgentProposalSafeAction(
    content,
    proposalData,
    expectedDefinitionId,
  );
  if (!action) return null;
  return {
    kind: "execute",
    actionId: actionRef.value.actionId as "agent.create" | "agent.update",
    action,
    proposal,
    idempotencyKey: actionRef.value.idempotencyKey,
  };
}

export function notifyAgentProposalActionAcknowledged(
  detail: AcknowledgedAgentProposalAction,
) {
  rememberAcknowledgedAgentProposalAction(detail);
  window.dispatchEvent(
    new CustomEvent<AcknowledgedAgentProposalAction>(
      ACKNOWLEDGED_ACTION_EVENT,
      { detail },
    ),
  );
}

export function rememberAcknowledgedAgentProposalAction(
  detail: AcknowledgedAgentProposalAction,
) {
  acknowledgedAgentProposalActions.set(detail.event.id, detail);
}

export function pendingAcknowledgedAgentProposalActions() {
  return [...acknowledgedAgentProposalActions.values()];
}

function resolveAcknowledgedAgentProposalAction(actionEventId: string) {
  acknowledgedAgentProposalActions.delete(actionEventId);
}

export function isAuthoritativeAgentProposalReceipt(input: {
  receipt: RelayEvent;
  ownerPubkey: string;
  channelId: string;
  actionEventId?: string;
  instanceEventId?: string;
}) {
  const { receipt, ownerPubkey, channelId, actionEventId, instanceEventId } =
    input;
  if (
    receipt.kind !== KIND_BLOCK_RECEIPT ||
    normalize(receipt.pubkey) !== normalize(ownerPubkey) ||
    exactChannelId(receipt) !== channelId ||
    !eventVerifies(receipt)
  ) {
    return false;
  }
  const parsed = parseBlockReceipt(receipt.tags);
  return (
    parsed.ok &&
    (!actionEventId || parsed.value.actionEventId === actionEventId) &&
    (!instanceEventId || parsed.value.instanceEventId === instanceEventId)
  );
}

async function existingReceiptForAction(actionEvent: RelayEvent) {
  const receipts = await relayClient.fetchEvents({
    kinds: [KIND_BLOCK_RECEIPT],
    "#e": [actionEvent.id],
    limit: 20,
  });
  const channelId = exactChannelId(actionEvent);
  if (!channelId) return undefined;
  return receipts.find((receipt) =>
    isAuthoritativeAgentProposalReceipt({
      receipt,
      ownerPubkey: actionEvent.pubkey,
      channelId,
      actionEventId: actionEvent.id,
    }),
  );
}

async function proposalAlreadyResolved(
  instanceEvent: RelayEvent,
  ownerPubkey: string,
) {
  const receipts = await relayClient.fetchEvents({
    kinds: [KIND_BLOCK_RECEIPT],
    "#e": [instanceEvent.id],
    limit: 50,
  });
  const channelId = exactChannelId(instanceEvent);
  if (!channelId) return false;
  return receipts.some((receipt) => {
    if (
      !isAuthoritativeAgentProposalReceipt({
        receipt,
        ownerPubkey,
        channelId,
        instanceEventId: instanceEvent.id,
      })
    ) {
      return false;
    }
    const parsed = parseBlockReceipt(receipt.tags);
    return parsed.ok && parsed.value.resolvesAttention;
  });
}

async function publishReceipt(
  actionEvent: RelayEvent,
  validated: ValidatedAgentProposalAction,
  result: AgentProposalReceiptResult,
  lease: AgentProposalCommunityLease,
): Promise<boolean> {
  if (!isCurrentAgentProposalCommunity(lease)) return false;
  const existing = await existingReceiptForAction(actionEvent);
  if (!isCurrentAgentProposalCommunity(lease)) return false;
  if (existing) return true;
  const resolved = result.outcome !== "failed";
  const status =
    result.outcome === "declined"
      ? "denied"
      : result.outcome === "failed"
        ? "failed"
        : "succeeded";
  const tags = [
    ["h", validated.proposal.channelId],
    ["e", actionEvent.id, "", "block-action"],
    ["e", validated.proposal.event.id, "", "block-instance"],
    [
      "block-receipt",
      "1",
      validated.proposal.instanceId,
      validated.idempotencyKey,
      status,
    ],
  ];
  if (resolved) tags.push(["block-attention", "1", "resolved"]);
  const receipt = await signRelayEvent({
    kind: KIND_BLOCK_RECEIPT,
    content: canonicalBlockJson(result),
    tags,
  });
  if (!isCurrentAgentProposalCommunity(lease)) return false;
  await relayClient.publishEvent(
    receipt,
    "Timed out while saving the Agent Proposal result.",
    "Failed to save the Agent Proposal result.",
  );
  return true;
}

async function fetchProposalInstance(actionEvent: RelayEvent) {
  const actionRef = parseBlockAction(actionEvent.tags);
  if (!actionRef.ok) return null;
  const [instance] = await relayClient.fetchEvents({
    ids: [actionRef.value.instanceEventId],
    kinds: [KIND_STREAM_MESSAGE],
    limit: 1,
  });
  return instance ?? null;
}

async function processAction(
  accepted: AcknowledgedAgentProposalAction,
  context: AgentProposalAuthorityContext,
  lease: AgentProposalCommunityLease,
): Promise<AgentProposalProcessOutcome> {
  if (!isCurrentAgentProposalCommunity(lease)) return "retry";
  const existing = await existingReceiptForAction(accepted.event);
  if (!isCurrentAgentProposalCommunity(lease)) return "retry";
  if (existing) return "complete";
  const instanceEvent = await fetchProposalInstance(accepted.event);
  if (!isCurrentAgentProposalCommunity(lease)) return "retry";
  if (!instanceEvent) return "retry";
  // A different valid action may have resolved the same proposal while this
  // acknowledgement was buffered. That is terminal for this local action too,
  // so allow the caller to discard it rather than retrying it forever.
  if (await proposalAlreadyResolved(instanceEvent, context.ownerPubkey)) {
    return "complete";
  }
  if (!isCurrentAgentProposalCommunity(lease)) return "retry";
  const validated = validateAgentProposalActionContext({
    actionEvent: accepted.event,
    instanceEvent,
    context,
  });
  if (!validated) return "ignored";

  let result: AgentProposalReceiptResult;
  if (validated.kind === "decline") {
    result = { outcome: "declined" };
  } else {
    if (!isCurrentAgentProposalCommunity(lease)) return "retry";
    try {
      const execution = await executeAgentProposal(
        validated.action,
        lease.relayUrl,
        accepted.backendConfig,
      );
      if (!isCurrentAgentProposalCommunity(lease)) return "retry";
      result =
        execution.status === "applied"
          ? {
              outcome:
                validated.actionId === "agent.create" ? "created" : "updated",
              definitionId: execution.definitionId,
              ...(execution.agentPubkey
                ? { agentPubkey: execution.agentPubkey }
                : {}),
              recovered: execution.recovered,
            }
          : { outcome: "failed", message: execution.safeMessage };
    } catch {
      result = {
        outcome: "failed",
        message: "Could not apply this Agent Proposal. Review and retry.",
      };
    }
  }
  return (await publishReceipt(accepted.event, validated, result, lease))
    ? "complete"
    : "retry";
}

/** Owner-side broker for acknowledged and crash-replayed Agent Proposals. */
export function useAgentProposalBroker({
  communityExecutionScope,
  relayUrl,
}: {
  communityExecutionScope: string;
  relayUrl: string;
}) {
  const identityQuery = useIdentityQuery();
  const managedAgentsQuery = useManagedAgentsQuery();
  const channelsQuery = useChannelsQuery();
  const personasQuery = usePersonasQuery();
  const communityLeaseRef = React.useRef<AgentProposalCommunityLease | null>(
    null,
  );

  React.useEffect(() => {
    if (!communityExecutionScope || !relayUrl) return;
    const lease = activateAgentProposalCommunity(
      communityExecutionScope,
      relayUrl,
    );
    communityLeaseRef.current = lease;
    return () => {
      deactivateAgentProposalCommunity(lease);
      if (communityLeaseRef.current === lease) {
        communityLeaseRef.current = null;
      }
    };
  }, [communityExecutionScope, relayUrl]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a community epoch change must replace the broker even before query snapshots change
  React.useEffect(() => {
    const ownerPubkey = identityQuery.data?.pubkey;
    const managedAgents = managedAgentsQuery.data;
    const channels = channelsQuery.data;
    const personas = personasQuery.data;
    const lease = communityLeaseRef.current;
    if (
      !ownerPubkey ||
      !managedAgents ||
      !channels ||
      !personas ||
      !lease ||
      !isCurrentAgentProposalCommunity(lease)
    )
      return;
    let active = true;
    let unsubscribeLive: (() => void | Promise<void>) | undefined;
    const processingActionIds = new Set<string>();
    const context = { ownerPubkey, managedAgents, channels, personas };
    const process = (accepted: AcknowledgedAgentProposalAction) => {
      if (!active || !isCurrentAgentProposalCommunity(lease)) return;
      const actionRef = parseBlockAction(accepted.event.tags);
      if (!actionRef.ok) return;
      if (processingActionIds.has(accepted.event.id)) return;
      processingActionIds.add(accepted.event.id);
      const proposalKey = agentProposalExecutionKey({
        ownerPubkey,
        communityExecutionScope: `${lease.executionScope}:${lease.generation}`,
        instanceEventId: actionRef.value.instanceEventId,
      });
      void processAgentProposalActionUntilTerminal({
        isActive: () => active && isCurrentAgentProposalCommunity(lease),
        operation: async () => {
          const outcome = await runAgentProposalActionOnce(
            proposalKey,
            accepted.event.id,
            () => processAction(accepted, context, lease),
            (result) => result === "complete",
          );
          return outcome ?? "complete";
        },
      })
        .then((outcome) => {
          if (outcome === "complete" || outcome === "ignored") {
            resolveAcknowledgedAgentProposalAction(accepted.event.id);
          }
        })
        .finally(() => {
          processingActionIds.delete(accepted.event.id);
        });
    };
    const replay = () => {
      void relayClient
        .fetchEvents({
          kinds: [KIND_BLOCK_ACTION],
          "#p": [normalize(ownerPubkey)],
          limit: 500,
        })
        .then((events) => {
          if (!active) return;
          for (const event of events) process({ event });
        });
    };
    const onAcknowledged = (event: Event) => {
      process((event as CustomEvent<AcknowledgedAgentProposalAction>).detail);
    };
    window.addEventListener(ACKNOWLEDGED_ACTION_EVENT, onAcknowledged);
    for (const acknowledged of pendingAcknowledgedAgentProposalActions()) {
      process(acknowledged);
    }
    replay();
    const unsubscribeReconnect = relayClient.subscribeToReconnects(replay);
    void relayClient
      .subscribeLive(
        {
          kinds: [KIND_BLOCK_ACTION],
          "#p": [normalize(ownerPubkey)],
          since: Math.floor(Date.now() / 1_000),
          limit: 0,
        },
        (event) => process({ event }),
      )
      .then((unsubscribe) => {
        if (!active) {
          void unsubscribe();
          return;
        }
        unsubscribeLive = unsubscribe;
      });
    return () => {
      active = false;
      window.removeEventListener(ACKNOWLEDGED_ACTION_EVENT, onAcknowledged);
      unsubscribeReconnect();
      void unsubscribeLive?.();
    };
  }, [
    channelsQuery.data,
    communityExecutionScope,
    identityQuery.data?.pubkey,
    managedAgentsQuery.data,
    personasQuery.data,
    relayUrl,
  ]);
}

export function useAgentProposalBrokerForCommunity(community: {
  activeCommunity: { id: string; relayUrl: string } | null;
  reinitKey: number;
}) {
  useAgentProposalBroker({
    communityExecutionScope: `${community.activeCommunity?.id ?? "none"}-${community.reinitKey}`,
    relayUrl: community.activeCommunity?.relayUrl ?? "",
  });
}
