import { signRelayEvent } from "@/shared/api/tauri";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";

import {
  assertScoutAcknowledgementEvent,
  parseSignedScoutEvent,
  scoutSetupAcknowledgementBody,
  scoutSetupAcknowledgementTag,
} from "../channelOnboardingSetup";
import type { ChannelOnboardingScope } from "../channelOnboardingStorage";
import type { ScoutSetupInput } from "../channelOnboarding/types";

export type ScoutAcknowledgementRecord = {
  eventId: string;
  /** Exact owner-signed event JSON, retained before any publish attempt. */
  signedEvent: string;
  /** False means publication may have been interrupted and must be retried. */
  published: boolean;
  receiptEventId?: string;
};

export type ScoutAcknowledgementDeliveryInput = {
  scope: ChannelOnboardingScope;
  input: ScoutSetupInput;
  approvalRequestId: string;
  scoutPubkey: string;
  existing?: ScoutAcknowledgementRecord | null;
};

export type ScoutAcknowledgementDeliveryDependencies = {
  sign?: typeof signRelayEvent;
  publish?: (event: RelayEvent, relayUrl: string) => Promise<unknown>;
  assertCurrent?: (scope: ChannelOnboardingScope) => Promise<void> | void;
  persistBeforePublish: (
    acknowledgement: ScoutAcknowledgementRecord,
  ) => Promise<void> | void;
  persistAfterPublish?: (
    acknowledgement: ScoutAcknowledgementRecord,
  ) => Promise<void> | void;
  now?: () => number;
};

function publishDefault(event: RelayEvent, relayUrl: string) {
  return relayClient.publishEvent(
    event,
    "Colony could not confirm Scout's setup request was delivered. Retry the same request.",
    "Colony could not deliver Scout's setup request. Retry the same request.",
    relayUrl,
  );
}

function validCreatedAt(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Build, verify, durably retain, and publish the owner-readable setup request.
 *
 * The durable callback runs after signing and before publication. If the
 * socket or relay acknowledgement is lost, a later call receives the same
 * signed event through `existing` and republishes it instead of signing a new
 * request or changing the reviewed snapshot.
 */
export function createScoutAcknowledgementDelivery(
  dependencies: ScoutAcknowledgementDeliveryDependencies,
) {
  const sign = dependencies.sign ?? signRelayEvent;
  const publish = dependencies.publish ?? publishDefault;
  const now = dependencies.now ?? Date.now;

  return async function deliver(
    input: ScoutAcknowledgementDeliveryInput,
  ): Promise<ScoutAcknowledgementRecord> {
    const existing = input.existing ?? null;
    let acknowledgement: ScoutAcknowledgementRecord;
    let event: RelayEvent;

    if (existing) {
      if (!existing.signedEvent || existing.eventId.trim() === "") {
        throw new Error(
          "The saved Scout acknowledgment cannot be retried safely. No new request was sent.",
        );
      }
      event = parseSignedScoutEvent(existing.signedEvent);
      if (event.id !== existing.eventId) {
        throw new Error(
          "The saved Scout acknowledgment changed. No new request was sent.",
        );
      }
      assertScoutAcknowledgementEvent(
        event,
        input.scope,
        input.input,
        existing.eventId,
        input.approvalRequestId,
        input.scoutPubkey,
      );
      acknowledgement = {
        eventId: existing.eventId,
        signedEvent: JSON.stringify(event),
        published: existing.published === true,
        ...(existing.receiptEventId
          ? { receiptEventId: existing.receiptEventId }
          : {}),
      };
    } else {
      const createdAt = Math.floor(now() / 1_000);
      if (!validCreatedAt(createdAt)) {
        throw new Error(
          "The setup acknowledgment clock could not be verified.",
        );
      }
      const eventTags = [
        ["h", input.scope.channelId],
        ["p", input.scoutPubkey],
        ["e", input.scope.threadRootId, "", "reply"],
        scoutSetupAcknowledgementTag(input.input, input.approvalRequestId),
      ];
      const signed = await sign({
        kind: 9,
        content: scoutSetupAcknowledgementBody(input.input),
        tags: eventTags,
        createdAt,
      });
      event = parseSignedScoutEvent(signed);
      assertScoutAcknowledgementEvent(
        event,
        input.scope,
        input.input,
        event.id,
        input.approvalRequestId,
        input.scoutPubkey,
      );
      acknowledgement = {
        eventId: event.id,
        signedEvent: JSON.stringify(event),
        published: false,
      };
    }

    if (acknowledgement.published) return acknowledgement;

    await dependencies.assertCurrent?.(input.scope);
    // This is intentionally before `publish`: an uncertain network result
    // leaves the exact signed event available for a safe retry.
    await dependencies.persistBeforePublish(acknowledgement);
    await dependencies.assertCurrent?.(input.scope);
    await publish(event, input.scope.relayUrl);
    await dependencies.assertCurrent?.(input.scope);
    const published = { ...acknowledgement, published: true };
    await dependencies.persistAfterPublish?.(published);
    return published;
  };
}
