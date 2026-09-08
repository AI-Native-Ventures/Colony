import { verifyEvent } from "nostr-tools/pure";
import type { RelayEvent } from "@/shared/api/types";
import {
  type FirstJobSuggestion,
  firstJobSuggestionBody,
  firstJobSuggestionTag,
  parseFirstJobSuggestion,
} from "./firstJobSuggestion";
import { firstJobSetupKey } from "./firstJobSetup";

/** A public setup message, not a task record or an instruction to run an agent. */
export type FirstJobSuggestionDeliveryDependencies = {
  storage: Pick<Storage, "getItem" | "setItem">;
  assertCurrent(scope: FirstJobSuggestion): Promise<void>;
  withLock<T>(name: string, work: () => Promise<T>): Promise<T>;
  sign(input: {
    kind: number;
    content: string;
    tags: string[][];
    createdAt: number;
  }): Promise<RelayEvent>;
  publish(event: RelayEvent, scope: FirstJobSuggestion): Promise<unknown>;
  now(): number;
};
type Attempt = {
  version: 1;
  payload: FirstJobSuggestion;
  marker: string;
  createdAt: number;
  event: RelayEvent | null;
  acknowledged: boolean;
};

function keyFor(payload: FirstJobSuggestion): string {
  return `${firstJobSetupKey(payload)}:suggestion:${JSON.stringify([payload.channelId, payload.requestId])}`;
}
function tagsFor(payload: FirstJobSuggestion, marker: string): string[][] {
  return [
    ["h", payload.channelId],
    ["client", marker],
    firstJobSuggestionTag(payload),
  ];
}
function validEvent(event: RelayEvent, attempt: Attempt): boolean {
  return (
    event.pubkey === attempt.payload.ownerPubkey &&
    event.kind === 9 &&
    event.created_at === attempt.createdAt &&
    event.content === firstJobSuggestionBody(attempt.payload) &&
    JSON.stringify(event.tags) ===
      JSON.stringify(tagsFor(attempt.payload, attempt.marker)) &&
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

/** Persist before signing/publishing; all retries publish the same authenticated root. */
export function createFirstJobSuggestionDelivery(
  deps: FirstJobSuggestionDeliveryDependencies,
) {
  const inFlight = new Map<
    string,
    { input: string; promise: Promise<{ eventId: string }> }
  >();
  function write(key: string, attempt: Attempt): void {
    const raw = JSON.stringify(attempt);
    if (raw.length > 131_072)
      throw new Error("This setup suggestion is too large to save.");
    try {
      deps.storage.setItem(key, raw);
      if (deps.storage.getItem(key) !== raw)
        throw new Error("Write was not retained");
    } catch {
      throw new Error(
        "Colony could not save this suggestion. Keep setup open and try again; no new request will be created.",
      );
    }
  }
  async function perform(
    payload: FirstJobSuggestion,
    marker: string,
    key: string,
  ): Promise<{ eventId: string }> {
    await deps.assertCurrent(payload);
    return deps.withLock(key, async () => {
      await deps.assertCurrent(payload);
      let attempt: Attempt;
      const raw = deps.storage.getItem(key);
      if (raw !== null) {
        try {
          if (raw.length > 131_072) throw new Error("Oversized attempt");
          attempt = JSON.parse(raw) as Attempt;
          if (
            attempt.version !== 1 ||
            JSON.stringify(attempt.payload) !== JSON.stringify(payload) ||
            attempt.marker !== marker ||
            !Number.isSafeInteger(attempt.createdAt) ||
            attempt.createdAt <= 0 ||
            typeof attempt.acknowledged !== "boolean" ||
            (attempt.event === null
              ? attempt.acknowledged
              : !validEvent(attempt.event, attempt))
          )
            throw new Error("Invalid saved suggestion");
        } catch {
          throw new Error(
            "Colony could not verify the saved suggestion. Keep its original business details and retry; another request has not been created.",
          );
        }
      } else {
        const createdAt = Math.floor(deps.now() / 1000);
        if (!Number.isSafeInteger(createdAt) || createdAt <= 0)
          throw new Error("The system clock could not be read.");
        attempt = {
          version: 1,
          payload,
          marker,
          createdAt,
          event: null,
          acknowledged: false,
        };
        write(key, attempt);
      }
      if (attempt.acknowledged && attempt.event)
        return { eventId: attempt.event.id };
      if (!attempt.event) {
        const event = await deps.sign({
          kind: 9,
          content: firstJobSuggestionBody(payload),
          tags: tagsFor(payload, marker),
          createdAt: attempt.createdAt,
        });
        await deps.assertCurrent(payload);
        if (!validEvent(event, attempt))
          throw new Error(
            "The signed suggestion does not match this account and business. Nothing was sent.",
          );
        attempt = { ...attempt, event };
        write(key, attempt);
      }
      await deps.assertCurrent(payload);
      const event = attempt.event;
      if (!event) throw new Error("The suggestion could not be signed.");
      await deps.publish(event, attempt.payload);
      await deps.assertCurrent(payload);
      write(key, { ...attempt, acknowledged: true });
      return { eventId: event.id };
    });
  }
  return {
    deliver(
      payload: FirstJobSuggestion,
      marker: string,
    ): Promise<{ eventId: string }> {
      // Copy validated fields so changes in a caller's object cannot mutate an awaiting send.
      const snapshot = parseFirstJobSuggestion([
        firstJobSuggestionTag(payload),
      ]);
      if (
        !snapshot ||
        typeof marker !== "string" ||
        !marker.trim() ||
        marker.length > 512 ||
        marker.includes("\u0000")
      )
        return Promise.reject(new Error("This setup suggestion is invalid."));
      const key = keyFor(snapshot);
      const input = JSON.stringify([snapshot, marker]);
      const pending = inFlight.get(key);
      if (pending)
        return pending.input === input
          ? pending.promise
          : Promise.reject(
              new Error(
                "The original suggestion is still being saved. Keep its business details and retry.",
              ),
            );
      const promise = perform(snapshot, marker, key).finally(() =>
        inFlight.delete(key),
      );
      inFlight.set(key, { input, promise });
      return promise;
    },
  };
}
