import * as React from "react";

import { canonicalBlockJson } from "@/features/blocks/blockActions";
import {
  parseBlockAction,
  parseBlockReceipt,
} from "@/features/blocks/blockTags";
import {
  clearOutreachActionRuns,
  eventVerifies,
  exactChannelId,
  NO_WEB_TAB_REASON,
  normalizeKey,
  outreachReceiptStatus,
  type OutreachSendReceiptResult,
  runOutreachActionOnce,
  validateOutreachSendAction,
  type ValidatedOutreachAction,
} from "@/features/blocks/outreachSendValidation";
import { processAgentProposalActionUntilTerminal } from "@/features/blocks/useAgentProposalBroker";
import { executeOutreachSend } from "@/shared/api/outreachSend";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_BLOCK_ACTION,
  KIND_BLOCK_RECEIPT,
  KIND_STREAM_MESSAGE,
} from "@/shared/constants/kinds";
import { useIdentityQuery } from "@/shared/api/hooks";

type OutreachSendLease = {
  executionScope: string;
  generation: number;
  results: Map<string, OutreachSendReceiptResult>;
};

let activeOutreachLease: OutreachSendLease | null = null;
let nextOutreachGeneration = 1;

function activateOutreachLease(executionScope: string): OutreachSendLease {
  const lease = {
    executionScope,
    generation: nextOutreachGeneration++,
    results: new Map<string, OutreachSendReceiptResult>(),
  };
  activeOutreachLease = lease;
  return lease;
}

function deactivateOutreachLease(lease: OutreachSendLease) {
  lease.results.clear();
  if (activeOutreachLease === lease) activeOutreachLease = null;
}

function isCurrentOutreachLease(lease: OutreachSendLease) {
  return activeOutreachLease === lease;
}

/** Drop every community-scoped outreach send state on a community change. */
export function resetOutreachSendBroker() {
  if (activeOutreachLease) deactivateOutreachLease(activeOutreachLease);
  activeOutreachLease = null;
  clearOutreachActionRuns();
}

function isOwnerOutreachReceipt(input: {
  receipt: RelayEvent;
  ownerPubkey: string;
  channelId: string;
  actionEventId: string;
}) {
  const { receipt, ownerPubkey, channelId, actionEventId } = input;
  if (
    receipt.kind !== KIND_BLOCK_RECEIPT ||
    normalizeKey(receipt.pubkey) !== normalizeKey(ownerPubkey) ||
    exactChannelId(receipt) !== channelId ||
    !eventVerifies(receipt)
  ) {
    return false;
  }
  const parsed = parseBlockReceipt(receipt.tags);
  return parsed.ok && parsed.value.actionEventId === actionEventId;
}

async function existingReceiptForAction(actionEvent: RelayEvent) {
  const channelId = exactChannelId(actionEvent);
  if (!channelId) return undefined;
  const receipts = await relayClient.fetchEvents({
    kinds: [KIND_BLOCK_RECEIPT],
    "#e": [actionEvent.id],
    limit: 20,
  });
  return receipts.find((receipt) =>
    isOwnerOutreachReceipt({
      receipt,
      ownerPubkey: actionEvent.pubkey,
      channelId,
      actionEventId: actionEvent.id,
    }),
  );
}

async function fetchInstanceEvent(actionEvent: RelayEvent) {
  const actionRef = parseBlockAction(actionEvent.tags);
  if (!actionRef.ok) return null;
  const [instance] = await relayClient.fetchEvents({
    ids: [actionRef.value.instanceEventId],
    kinds: [KIND_STREAM_MESSAGE],
    limit: 1,
  });
  return instance ?? null;
}

async function publishOutreachReceipt(
  actionEvent: RelayEvent,
  validated: ValidatedOutreachAction,
  result: OutreachSendReceiptResult,
  lease: OutreachSendLease,
): Promise<boolean> {
  if (!isCurrentOutreachLease(lease)) return false;
  const status = outreachReceiptStatus(result);
  const tags = [
    ["h", validated.channelId],
    ["e", actionEvent.id, "", "block-action"],
    ["e", validated.instanceEventId, "", "block-instance"],
    [
      "block-receipt",
      "1",
      validated.instanceId,
      validated.idempotencyKey,
      status,
    ],
  ];
  // A failed send leaves the card open, so the owner can try again once their
  // Gmail tab is back. Only a real outcome resolves the decision.
  if (status !== "failed") tags.push(["block-attention", "1", "resolved"]);
  const receipt = await signRelayEvent({
    kind: KIND_BLOCK_RECEIPT,
    content: canonicalBlockJson(result),
    tags,
  });
  if (!isCurrentOutreachLease(lease)) return false;
  await relayClient.publishEvent(
    receipt,
    "Timed out while saving the outreach email result.",
    "Failed to save the outreach email result.",
  );
  return true;
}

async function processOutreachAction(
  actionEvent: RelayEvent,
  ownerPubkey: string,
  lease: OutreachSendLease,
): Promise<"complete" | "retry" | "ignored"> {
  if (!isCurrentOutreachLease(lease)) return "retry";
  const existing = await existingReceiptForAction(actionEvent);
  if (!isCurrentOutreachLease(lease)) return "retry";
  if (existing) {
    lease.results.delete(actionEvent.id);
    return "complete";
  }
  const instanceEvent = await fetchInstanceEvent(actionEvent);
  if (!isCurrentOutreachLease(lease)) return "retry";
  if (!instanceEvent) return "retry";
  const validated = validateOutreachSendAction({
    actionEvent,
    instanceEvent,
    ownerPubkey,
  });
  if (!validated) {
    lease.results.delete(actionEvent.id);
    return "ignored";
  }

  // A relay read or publication can fail after the email has already left.
  // Keep the outcome so a retry only republishes the receipt.
  let result = lease.results.get(actionEvent.id);
  if (!result) {
    if (validated.kind === "skip") {
      result = { outcome: "skipped", status_label: "skipped" };
    } else {
      try {
        const outcome = await executeOutreachSend({
          instanceEventId: validated.instanceEventId,
          actionEventId: actionEvent.id,
          data: {
            destination: validated.destination,
            content: { subject: validated.subject, body: validated.body },
          },
        });
        result =
          outcome.status === "sent"
            ? {
                outcome: "sent",
                status_label: "sent",
                sent_at: outcome.sentAt,
                to: outcome.to,
                subject: outcome.subject,
              }
            : { outcome: "failed", failure_reason: outcome.failureReason };
      } catch {
        result = { outcome: "failed", failure_reason: NO_WEB_TAB_REASON };
      }
    }
  }
  if (!isCurrentOutreachLease(lease)) return "retry";
  lease.results.set(actionEvent.id, result);
  if (!(await publishOutreachReceipt(actionEvent, validated, result, lease))) {
    return "retry";
  }
  lease.results.delete(actionEvent.id);
  return "complete";
}

/**
 * Owner-side broker turning an approved outreach card into a real send.
 *
 * Approve runs the Gmail journey in the owner's own tab and receipts the card
 * as `sent`; Skip receipts it as `skipped` without touching the browser.
 */
export function useOutreachSendBroker({
  communityExecutionScope,
}: {
  communityExecutionScope: string;
}) {
  const identityQuery = useIdentityQuery();
  const leaseRef = React.useRef<OutreachSendLease | null>(null);

  React.useEffect(() => {
    if (!communityExecutionScope) return;
    const lease = activateOutreachLease(communityExecutionScope);
    leaseRef.current = lease;
    return () => {
      deactivateOutreachLease(lease);
      if (leaseRef.current === lease) leaseRef.current = null;
    };
  }, [communityExecutionScope]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a community epoch change must replace the broker even before the identity snapshot changes
  React.useEffect(() => {
    const ownerPubkey = identityQuery.data?.pubkey;
    const lease = leaseRef.current;
    if (!ownerPubkey || !lease || !isCurrentOutreachLease(lease)) return;
    let active = true;
    let unsubscribeLive: (() => void | Promise<void>) | undefined;
    const processingActionIds = new Set<string>();
    const process = (actionEvent: RelayEvent) => {
      if (!active || !isCurrentOutreachLease(lease)) return;
      if (processingActionIds.has(actionEvent.id)) return;
      processingActionIds.add(actionEvent.id);
      const actionKey = `${normalizeKey(ownerPubkey)}:${lease.executionScope}:${lease.generation}:${actionEvent.id}`;
      void processAgentProposalActionUntilTerminal({
        isActive: () => active && isCurrentOutreachLease(lease),
        operation: () =>
          runOutreachActionOnce(actionKey, () =>
            processOutreachAction(actionEvent, ownerPubkey, lease),
          ),
      }).finally(() => {
        processingActionIds.delete(actionEvent.id);
      });
    };
    const replay = () => {
      void relayClient
        .fetchEvents({
          kinds: [KIND_BLOCK_ACTION],
          "#p": [normalizeKey(ownerPubkey)],
          limit: 500,
        })
        .then((events) => {
          if (!active) return;
          for (const event of events) process(event);
        });
    };
    replay();
    const unsubscribeReconnect = relayClient.subscribeToReconnects(replay);
    void relayClient
      .subscribeLive(
        {
          kinds: [KIND_BLOCK_ACTION],
          "#p": [normalizeKey(ownerPubkey)],
          since: Math.floor(Date.now() / 1_000),
          limit: 0,
        },
        (event) => process(event),
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
      unsubscribeReconnect();
      void unsubscribeLive?.();
    };
  }, [communityExecutionScope, identityQuery.data?.pubkey]);
}

export function useOutreachSendBrokerForCommunity(community: {
  activeCommunity: { id: string } | null;
  reinitKey: number;
}) {
  useOutreachSendBroker({
    communityExecutionScope: `${community.activeCommunity?.id ?? "none"}-${community.reinitKey}`,
  });
}
