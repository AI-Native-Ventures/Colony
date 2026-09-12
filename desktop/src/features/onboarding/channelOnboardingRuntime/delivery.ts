import { verifyEvent } from "nostr-tools/pure";

import type { RelayEvent } from "@/shared/api/types";
import {
  SCOUT_ONBOARDING_ROOT_KIND,
  SCOUT_ONBOARDING_ROOT_STORAGE_PREFIX,
  scoutOnboardingRootBody,
  scoutOnboardingRootStorageKey,
  scoutOnboardingRootTag,
  scoutOnboardingRootTags,
  parseScoutOnboardingRoot,
  type ScoutOnboardingRootPayload,
  type ScoutOnboardingRootScope,
} from "./protocol";

export type ScoutOnboardingRootDeliveryDependencies = {
  storage: Pick<Storage, "getItem" | "setItem">;
  assertCurrent(scope: ScoutOnboardingRootScope): Promise<void>;
  withLock<T>(name: string, work: () => Promise<T>): Promise<T>;
  sign(input: {
    kind: number;
    content: string;
    tags: string[][];
    createdAt: number;
  }): Promise<RelayEvent>;
  publish(
    event: RelayEvent,
    payload: ScoutOnboardingRootPayload,
  ): Promise<unknown>;
  now(): number;
};

type RootAttempt = {
  version: 1;
  payload: ScoutOnboardingRootPayload;
  createdAt: number;
  event: RelayEvent | null;
  acknowledged: boolean;
};

/**
 * Keep the generic post-completion starter hook from seeding a choice-first
 * Welcome root. The root delivery record is already keyed by the complete
 * owner, relay, channel, root, and signup tuple; this community-level lookup
 * only answers whether any such choice flow has begun for the active owner.
 *
 * The key is written before signing or publishing. A matching key, including
 * one whose value is corrupt or incomplete, is therefore a fail-closed
 * reservation. Suppression can only defer setup; it cannot authorize it.
 */
export function hasScoutOnboardingRootAttempt(
  ownerPubkey: string,
  relayUrl: string,
): boolean {
  try {
    const storage = globalThis.localStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(SCOUT_ONBOARDING_ROOT_STORAGE_PREFIX)) continue;
      let keyScope: unknown;
      try {
        keyScope = JSON.parse(
          key.slice(SCOUT_ONBOARDING_ROOT_STORAGE_PREFIX.length),
        );
      } catch {
        continue;
      }
      if (
        !Array.isArray(keyScope) ||
        keyScope.length !== 4 ||
        !keyScope.every((part) => typeof part === "string") ||
        keyScope[0] !== ownerPubkey ||
        keyScope[1] !== relayUrl
      ) {
        continue;
      }
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function validEvent(event: RelayEvent, attempt: RootAttempt): boolean {
  const payload = attempt.payload;
  return (
    event.pubkey === payload.ownerPubkey &&
    event.kind === SCOUT_ONBOARDING_ROOT_KIND &&
    event.created_at === attempt.createdAt &&
    event.content === scoutOnboardingRootBody(payload) &&
    JSON.stringify(event.tags) ===
      JSON.stringify(scoutOnboardingRootTags(payload)) &&
    /^[a-f0-9]{64}$/.test(event.id) &&
    /^[a-f0-9]{128}$/.test(event.sig) &&
    verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    })
  );
}

function writeAttempt(
  dependencies: ScoutOnboardingRootDeliveryDependencies,
  key: string,
  attempt: RootAttempt,
) {
  const raw = JSON.stringify(attempt);
  if (raw.length > 131_072) {
    throw new Error("This signup context is too large to save.");
  }
  try {
    dependencies.storage.setItem(key, raw);
    if (dependencies.storage.getItem(key) !== raw) {
      throw new Error("Write was not retained");
    }
  } catch {
    throw new Error(
      "Colony could not save this signup context. Keep setup open and retry the same request.",
    );
  }
}

function readAttempt(
  dependencies: ScoutOnboardingRootDeliveryDependencies,
  key: string,
  payload: ScoutOnboardingRootPayload,
): RootAttempt | null {
  const raw = dependencies.storage.getItem(key);
  if (raw === null) return null;
  try {
    if (raw.length > 131_072) throw new Error("Oversized attempt");
    const attempt = JSON.parse(raw) as RootAttempt;
    if (
      attempt?.version !== 1 ||
      JSON.stringify(attempt.payload) !== JSON.stringify(payload) ||
      !Number.isSafeInteger(attempt.createdAt) ||
      attempt.createdAt <= 0 ||
      typeof attempt.acknowledged !== "boolean" ||
      (attempt.event === null
        ? attempt.acknowledged
        : !validEvent(attempt.event, attempt))
    ) {
      throw new Error("Invalid saved root");
    }
    return attempt;
  } catch {
    throw new Error(
      "Colony could not verify the saved signup context. No second root will be created.",
    );
  }
}

/** Durable, owner-signed delivery for the choice-first Welcome root. */
export function createScoutOnboardingRootDelivery(
  dependencies: ScoutOnboardingRootDeliveryDependencies,
) {
  const inFlight = new Map<
    string,
    { input: string; promise: Promise<{ eventId: string }> }
  >();

  async function perform(
    payload: ScoutOnboardingRootPayload,
    key: string,
  ): Promise<{ eventId: string }> {
    await dependencies.assertCurrent(payload);
    return dependencies.withLock(key, async () => {
      await dependencies.assertCurrent(payload);
      let attempt = readAttempt(dependencies, key, payload);
      if (!attempt) {
        const createdAt = Math.floor(dependencies.now() / 1000);
        if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
          throw new Error("The system clock could not be read.");
        }
        attempt = {
          version: 1,
          payload,
          createdAt,
          event: null,
          acknowledged: false,
        };
        writeAttempt(dependencies, key, attempt);
      }

      if (attempt.acknowledged && attempt.event) {
        return { eventId: attempt.event.id };
      }

      if (!attempt.event) {
        const event = await dependencies.sign({
          kind: SCOUT_ONBOARDING_ROOT_KIND,
          content: scoutOnboardingRootBody(payload),
          tags: scoutOnboardingRootTags(payload),
          createdAt: attempt.createdAt,
        });
        await dependencies.assertCurrent(payload);
        if (!validEvent(event, attempt)) {
          throw new Error(
            "The signed signup context does not match this account. Nothing was sent.",
          );
        }
        attempt = { ...attempt, event };
        writeAttempt(dependencies, key, attempt);
      }

      await dependencies.assertCurrent(payload);
      const event = attempt.event;
      if (!event) throw new Error("The signup context could not be signed.");
      await dependencies.publish(event, payload);
      await dependencies.assertCurrent(payload);
      writeAttempt(dependencies, key, { ...attempt, acknowledged: true });
      return { eventId: event.id };
    });
  }

  return {
    deliver(payload: ScoutOnboardingRootPayload): Promise<{ eventId: string }> {
      const snapshot = parseScoutOnboardingRoot([
        scoutOnboardingRootTag(payload),
      ]);
      if (!snapshot) {
        return Promise.reject(new Error("This signup context is invalid."));
      }
      const key = scoutOnboardingRootStorageKey(snapshot);
      const input = JSON.stringify(snapshot);
      const pending = inFlight.get(key);
      if (pending) {
        return pending.input === input
          ? pending.promise
          : Promise.reject(
              new Error(
                "The original signup context is still being saved. Retry with its original answers.",
              ),
            );
      }
      const promise = perform(snapshot, key).finally(() =>
        inFlight.delete(key),
      );
      inFlight.set(key, { input, promise });
      return promise;
    },
  };
}
