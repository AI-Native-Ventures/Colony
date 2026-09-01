import { verifyEvent } from "nostr-tools/pure";

import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_COMPANY_ACTION,
  KIND_COMPANY_RECEIPT,
} from "@/shared/constants/kinds";

import {
  COMPANY_RECEIPT_SCHEMA,
  canonicalCompanyJson,
  normalizeHex,
} from "./contracts";

/**
 * Submitting an owner-signed Company Action and resolving what the relay did
 * with it.
 *
 * The desktop never signs a company head. It transports an action the backend
 * built and signed, then waits for the relay's own receipt to learn the
 * outcome. Treating a successful publish as a successful write would report
 * "done" for actions the relay went on to refuse.
 */

const HEX_64 = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_ATTEMPTS = 20;
const DEFAULT_INTERVAL_MS = 400;

export const COMPANY_RECEIPT_OUTCOMES = [
  "applied",
  "rejected",
  "conflict",
  "failed",
] as const;
export type CompanyReceiptOutcome = (typeof COMPANY_RECEIPT_OUTCOMES)[number];

export type CompanyReceipt = {
  receiptEventId: string;
  actionEventId: string;
  target: string;
  requestId: string;
  idempotencyKey: string;
  outcome: CompanyReceiptOutcome;
  headEventId: string | null;
};

export type CompanyActionOutcome =
  | {
      status: "applied";
      receiptEventId: string;
      headEventId: string;
      target: string;
    }
  | {
      status: "rejected" | "conflict" | "failed";
      receiptEventId: string;
      target: string;
      message: string;
    }
  | { status: "no-receipt"; actionEventId: string; message: string }
  | {
      status: "superseded";
      actionEventId: string;
      winnerEventId: string;
      message: string;
    };

export type CompanyActionBrokerDependencies = {
  publish: (event: RelayEvent) => Promise<RelayEvent>;
  fetchFirstEvent: (
    filter: RelaySubscriptionFilter,
  ) => Promise<RelayEvent | null>;
  relaySelf: () => Promise<string | null>;
  delay?: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
};

function tagValues(event: RelayEvent, name: string): string[][] {
  return event.tags.filter((tag) => tag[0] === name);
}

/** The exact three-tag envelope `build_company_action` produces. */
function readActionEnvelope(event: RelayEvent): {
  requestId: string;
  idempotencyKey: string;
  target: string;
} {
  if (event.kind !== KIND_COMPANY_ACTION) {
    throw new Error("Only a company action can be submitted here.");
  }
  const names = new Set(event.tags.map((tag) => tag[0]));
  if (
    names.size !== 3 ||
    !names.has("p") ||
    !names.has("a") ||
    !names.has("company-action")
  ) {
    throw new Error("This company action envelope is not the expected shape.");
  }
  const target = tagValues(event, "a")[0]?.[1];
  const tuple = tagValues(event, "company-action")[0];
  if (
    !target ||
    !tuple ||
    tuple.length !== 5 ||
    tuple[1] !== "1" ||
    !UUID.test(tuple[3] ?? "") ||
    !UUID.test(tuple[4] ?? "")
  ) {
    throw new Error("This company action envelope is not the expected shape.");
  }
  return {
    requestId: (tuple[3] as string).toLowerCase(),
    idempotencyKey: (tuple[4] as string).toLowerCase(),
    target,
  };
}

/**
 * Read a relay-signed receipt, or null.
 *
 * A receipt is only evidence because the tenant relay signed it; one signed by
 * anyone else is a member claiming an outcome the relay never reached.
 */
export function parseCompanyReceipt(
  event: RelayEvent,
  relaySelfPubkey: string,
  actionEventId: string,
): CompanyReceipt | null {
  const relay = normalizeHex(relaySelfPubkey);
  if (
    event.kind !== KIND_COMPANY_RECEIPT ||
    relay === "" ||
    normalizeHex(event.pubkey) !== relay
  ) {
    return null;
  }
  try {
    if (
      !verifyEvent({
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags.map((tag) => [...tag]),
        content: event.content,
        sig: event.sig,
      })
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const actionTags = tagValues(event, "e").filter(
    (tag) => tag[3] === "company-action",
  );
  const targets = tagValues(event, "a");
  const tuples = tagValues(event, "company-receipt");
  if (
    actionTags.length !== 1 ||
    targets.length !== 1 ||
    tuples.length !== 1 ||
    tagValues(event, "p").length !== 1
  ) {
    return null;
  }
  const tuple = tuples[0] as string[];
  const referenced = normalizeHex(actionTags[0]?.[1] ?? "");
  const target = targets[0]?.[1];
  if (
    referenced !== normalizeHex(actionEventId) ||
    !target ||
    tuple.length !== 5 ||
    tuple[1] !== "1" ||
    !UUID.test(tuple[2] ?? "") ||
    !UUID.test(tuple[3] ?? "") ||
    !COMPANY_RECEIPT_OUTCOMES.includes(tuple[4] as CompanyReceiptOutcome)
  ) {
    return null;
  }

  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (
    typeof content !== "object" ||
    content === null ||
    Array.isArray(content) ||
    canonicalCompanyJson(content) !== event.content
  ) {
    return null;
  }
  const { schema, headEventId } = content as Record<string, unknown>;
  if (
    Object.keys(content).length !== 2 ||
    schema !== COMPANY_RECEIPT_SCHEMA ||
    !(headEventId === null || typeof headEventId === "string")
  ) {
    return null;
  }
  const outcome = tuple[4] as CompanyReceiptOutcome;
  // Only an applied action names a head, and it must name a real event ID.
  if (outcome === "applied") {
    if (
      typeof headEventId !== "string" ||
      !HEX_64.test(normalizeHex(headEventId))
    ) {
      return null;
    }
  } else if (headEventId !== null) {
    return null;
  }

  return {
    receiptEventId: event.id,
    actionEventId: referenced,
    target,
    requestId: (tuple[2] as string).toLowerCase(),
    idempotencyKey: (tuple[3] as string).toLowerCase(),
    outcome,
    headEventId:
      typeof headEventId === "string" ? normalizeHex(headEventId) : null,
  };
}

/**
 * The relay's exact wording for a duplicate idempotency claim that a
 * different event already won: `"conflict: superseded by original action
 * <event id>"` (`broker_duplicate_result` in
 * `buzz-relay/handlers/ingest.rs`, called with the noun `"action"` for
 * every `KIND_COMPANY_ACTION` submission).
 *
 * This is a wire-message regex, not a structured field, because there is
 * no structured field to read: a NIP-01 `OK` frame is four bare elements
 * (`["OK", id, accepted, message]`), so the message text is the only
 * signal the relay has to distinguish this case from any other refusal.
 * `IngestResult::new`'s own prefix contract keeps the wording stable, but a
 * relay-side rewording still silently stops this from matching — worth
 * moving to a structured field (e.g. a `superseded_by` alongside `outcome`)
 * if this pattern needs to carry more cases than this one.
 */
const SUPERSEDED_MESSAGE =
  /^conflict: superseded by original action ([0-9a-f]{64})$/;

/**
 * The winning event's id, when `error` is the relay's rejection of a
 * company action superseded by an earlier claim on the same idempotency
 * key — otherwise `null`.
 */
function supersededWinnerEventId(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return SUPERSEDED_MESSAGE.exec(error.message)?.[1] ?? null;
}

export function createCompanyActionBroker(
  dependencies: CompanyActionBrokerDependencies,
) {
  const attempts = dependencies.attempts ?? DEFAULT_ATTEMPTS;
  const intervalMs = dependencies.intervalMs ?? DEFAULT_INTERVAL_MS;
  const delay =
    dependencies.delay ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async submit(signedActionJson: string): Promise<CompanyActionOutcome> {
      const event = JSON.parse(signedActionJson) as RelayEvent;
      const envelope = readActionEnvelope(event);
      const relaySelfPubkey = await dependencies.relaySelf();
      if (!relaySelfPubkey) {
        throw new Error(
          "This community's relay has no stable identity, so it cannot answer a company action.",
        );
      }

      let published: RelayEvent;
      try {
        published = await dependencies.publish(event);
      } catch (error) {
        const winnerEventId = supersededWinnerEventId(error);
        // The relay's idempotency claim on this action's idempotency key was
        // already won — by an earlier attempt at this exact send, most
        // likely. That is the goal state a retry was trying to reach, not a
        // failure: the winning event is named, so the caller can read the
        // Task it produced instead of refusing the send.
        if (winnerEventId !== null) {
          return {
            status: "superseded",
            actionEventId: event.id,
            winnerEventId,
            message:
              "This exact change was already applied by an earlier attempt.",
          };
        }
        throw error;
      }
      const actionEventId = published.id || event.id;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const candidate = await dependencies.fetchFirstEvent({
          kinds: [KIND_COMPANY_RECEIPT],
          authors: [relaySelfPubkey],
          "#e": [actionEventId],
          limit: 1,
        });
        const receipt = candidate
          ? parseCompanyReceipt(candidate, relaySelfPubkey, actionEventId)
          : null;
        if (
          receipt &&
          receipt.requestId === envelope.requestId &&
          receipt.idempotencyKey === envelope.idempotencyKey
        ) {
          if (receipt.outcome === "applied") {
            return {
              status: "applied",
              receiptEventId: receipt.receiptEventId,
              headEventId: receipt.headEventId as string,
              target: receipt.target,
            };
          }
          return {
            status: receipt.outcome,
            receiptEventId: receipt.receiptEventId,
            target: receipt.target,
            message:
              receipt.outcome === "conflict"
                ? "This record changed while the request was in flight."
                : "The relay refused this company change.",
          };
        }
        if (attempt < attempts - 1) await delay(intervalMs);
      }

      // The action is published and may still be applied. Saying "failed"
      // would invite a duplicate request; the caller retries with the same
      // idempotency key instead.
      return {
        status: "no-receipt",
        actionEventId,
        message:
          "The relay has not answered this company change yet. Trying again is safe.",
      };
    },
  };
}

export type CompanyActionBroker = ReturnType<typeof createCompanyActionBroker>;

export const companyActionBroker = createCompanyActionBroker({
  publish: (event) =>
    relayClient.publishEvent(
      event,
      "Timed out while sending the company change.",
      "The company change could not be sent.",
    ),
  fetchFirstEvent: (filter) => relayClient.fetchFirstEvent(filter),
  relaySelf: getRelaySelf,
});
