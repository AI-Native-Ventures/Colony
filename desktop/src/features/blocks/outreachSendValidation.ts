import { verifyEvent } from "nostr-tools/pure";

import {
  parseBlockAction,
  parseBlockInstance,
} from "@/features/blocks/blockTags";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_BLOCK_ACTION,
  KIND_STREAM_MESSAGE,
} from "@/shared/constants/kinds";

/** The composite whose Approve button the outreach broker may act on. */
export const OUTREACH_EMAIL_HANDLE = "outreach-email";
/** Approving a card is what sends the email. */
export const OUTREACH_APPROVE_ACTION_ID = "outreach.approve";
/** Skipping a card resolves it without touching the browser. */
export const OUTREACH_SKIP_ACTION_ID = "outreach.skip";

/** Shown when the owner has no shared Web tab for the journey to run in. */
export const NO_WEB_TAB_REASON =
  "Open your Gmail in the Web tab and try Approve again.";

/** The receipt body an outreach decision publishes. */
export type OutreachSendReceiptResult =
  | {
      outcome: "sent";
      status_label: "sent";
      sent_at: number;
      to: string;
      subject: string;
    }
  | { outcome: "skipped"; status_label: "skipped" }
  | { outcome: "failed"; failure_reason: string };

/** An owner decision this desktop is allowed to carry out. */
export type ValidatedOutreachAction = {
  kind: "send" | "skip";
  channelId: string;
  instanceId: string;
  instanceEventId: string;
  idempotencyKey: string;
  destination: string;
  subject: string;
  body: string;
};

export function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}

function tagsNamed(event: RelayEvent, name: string) {
  return event.tags.filter((tag) => tag[0] === name);
}

export function exactChannelId(event: RelayEvent): string | null {
  const tags = tagsNamed(event, "h");
  return tags.length === 1 && tags[0]?.length === 2
    ? (tags[0]?.[1] ?? null)
    : null;
}

export function eventVerifies(event: RelayEvent) {
  try {
    // Clone the wire fields: a nostr-tools verification memo travels with the
    // object, so verifying the caller's object can answer for an event that is
    // no longer the one in hand.
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    });
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * An `outreach.approve` or `outreach.skip` the owner signed for their own
 * pending outreach card, or `null` for anything else.
 *
 * The whole authority chain is checked here: the owner signed the action, the
 * owner is the card's processor and its decision maker, the action names this
 * exact instance, and the card is still pending.
 */
export function validateOutreachSendAction(input: {
  actionEvent: RelayEvent;
  instanceEvent: RelayEvent;
  ownerPubkey: string;
}): ValidatedOutreachAction | null {
  const { actionEvent, instanceEvent } = input;
  const ownerPubkey = normalizeKey(input.ownerPubkey);
  if (
    actionEvent.kind !== KIND_BLOCK_ACTION ||
    instanceEvent.kind !== KIND_STREAM_MESSAGE ||
    normalizeKey(actionEvent.pubkey) !== ownerPubkey ||
    !eventVerifies(actionEvent) ||
    !eventVerifies(instanceEvent)
  ) {
    return null;
  }
  const ownerTags = tagsNamed(actionEvent, "p");
  if (
    ownerTags.length !== 1 ||
    ownerTags[0]?.length !== 2 ||
    normalizeKey(ownerTags[0]?.[1] ?? "") !== ownerPubkey
  ) {
    return null;
  }
  const actionRef = parseBlockAction(actionEvent.tags);
  const instanceRef = parseBlockInstance(instanceEvent.tags);
  if (!actionRef.ok || !instanceRef.ok) return null;
  const channelId = exactChannelId(actionEvent);
  if (
    !channelId ||
    channelId !== exactChannelId(instanceEvent) ||
    actionRef.value.instanceEventId !== instanceEvent.id ||
    actionRef.value.instanceId !== instanceRef.value.instanceId ||
    actionRef.value.manifestId !== instanceRef.value.manifestId ||
    normalizeKey(actionRef.value.processorPubkey) !== ownerPubkey ||
    instanceRef.value.handle !== OUTREACH_EMAIL_HANDLE ||
    !instanceRef.value.attentionRequired ||
    normalizeKey(instanceRef.value.decisionMakerPubkey ?? "") !== ownerPubkey ||
    normalizeKey(instanceRef.value.processorPubkey ?? "") !== ownerPubkey ||
    instanceRef.value.data.type !== "inline"
  ) {
    return null;
  }
  const data = instanceRef.value.data.value as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const content = data.content as Record<string, unknown> | undefined;
  if (
    data.status !== "pending" ||
    !nonEmptyString(data.destination) ||
    !content ||
    typeof content !== "object" ||
    Array.isArray(content) ||
    !nonEmptyString(content.subject) ||
    !nonEmptyString(content.body)
  ) {
    return null;
  }
  const kind =
    actionRef.value.actionId === OUTREACH_APPROVE_ACTION_ID
      ? "send"
      : actionRef.value.actionId === OUTREACH_SKIP_ACTION_ID
        ? "skip"
        : null;
  if (!kind) return null;
  return {
    kind,
    channelId,
    instanceId: instanceRef.value.instanceId,
    instanceEventId: instanceEvent.id,
    idempotencyKey: actionRef.value.idempotencyKey,
    destination: data.destination,
    subject: content.subject,
    body: content.body,
  };
}

/** The receipt status a result publishes under. */
export function outreachReceiptStatus(
  result: OutreachSendReceiptResult,
): "succeeded" | "denied" | "failed" {
  if (result.outcome === "sent") return "succeeded";
  return result.outcome === "skipped" ? "denied" : "failed";
}

// One run per action event id. A replayed action joins the run already in
// flight instead of starting a second Gmail journey for the same approval.
const outreachRunsInFlight = new Map<string, Promise<unknown>>();

export function runOutreachActionOnce<T>(
  actionKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const existing = outreachRunsInFlight.get(actionKey);
  if (existing) return existing as Promise<T>;
  const pending = operation().finally(() => {
    if (outreachRunsInFlight.get(actionKey) === pending) {
      outreachRunsInFlight.delete(actionKey);
    }
  });
  outreachRunsInFlight.set(actionKey, pending);
  return pending;
}

export function clearOutreachActionRuns() {
  outreachRunsInFlight.clear();
}
