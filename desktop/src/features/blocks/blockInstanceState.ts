import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_BLOCK_ACTION,
  KIND_BLOCK_RECEIPT,
} from "@/shared/constants/kinds";

import {
  isAuthorizedBlockReceipt,
  parseBlockAction,
  parseBlockReceipt,
} from "./blockTags";

export type BlockInstanceState = {
  actions: RelayEvent[];
  receipts: RelayEvent[];
};

function compareEventOrder(left: RelayEvent, right: RelayEvent): number {
  return left.created_at - right.created_at || left.id.localeCompare(right.id);
}

/**
 * Durable Block state for a single instance event, built from whatever
 * auxiliary events were fetched for it.
 *
 * The timeline derives the same thing for a whole page of messages. This is
 * the one-instance form, used by surfaces that open a Block on its own (the
 * Action Center) rather than as a row in a channel. It applies the identical
 * authority gauntlet: an action must parse and name this exact instance, and a
 * receipt must parse, reference one of those actions, and pass
 * {@link isAuthorizedBlockReceipt}, which re-verifies all three signatures and
 * pins the receipt's signer to the action's processor. Only the newest
 * authorized receipt per action survives.
 */
export function buildBlockInstanceState(
  instanceEvent: RelayEvent,
  auxEvents: readonly RelayEvent[],
): BlockInstanceState | undefined {
  const instanceEventId = instanceEvent.id.toLowerCase();
  const actionById = new Map<string, RelayEvent>();
  const actions: RelayEvent[] = [];

  for (const event of auxEvents) {
    if (event.kind !== KIND_BLOCK_ACTION) continue;
    const action = parseBlockAction(event.tags);
    if (!action.ok || action.value.instanceEventId !== instanceEventId) {
      continue;
    }
    actionById.set(event.id.toLowerCase(), event);
    actions.push(event);
  }

  const newestReceiptByAction = new Map<string, RelayEvent>();
  for (const event of auxEvents) {
    if (event.kind !== KIND_BLOCK_RECEIPT) continue;
    const receipt = parseBlockReceipt(event.tags);
    if (!receipt.ok || receipt.value.instanceEventId !== instanceEventId) {
      continue;
    }
    const actionEvent = actionById.get(receipt.value.actionEventId);
    if (!isAuthorizedBlockReceipt(actionEvent, event, instanceEvent)) continue;
    const current = newestReceiptByAction.get(receipt.value.actionEventId);
    if (!current || compareEventOrder(current, event) < 0) {
      newestReceiptByAction.set(receipt.value.actionEventId, event);
    }
  }

  if (actions.length === 0 && newestReceiptByAction.size === 0) {
    return undefined;
  }
  return {
    actions: actions.sort(compareEventOrder),
    receipts: [...newestReceiptByAction.values()].sort(compareEventOrder),
  };
}
