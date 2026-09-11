/**
 * Shared per-(community, channel, relay-self) head loader.
 *
 * Every message row mounts the attachment, so the fetch must be owned here
 * rather than by each row: concurrent mounts join one in-flight promise, a
 * fresh load is reused for a quiet window, and a rate-limited or failed load
 * backs off without surfacing anything to the user. The relay's per-connection
 * quota is shared with message hydration, reactions, and threads, so the
 * loader retries only after the backoff elapses (or when an explicit
 * subscription change asks for a new key).
 *
 * Pure state machine with injected fetch/apply/clock/timer dependencies so it
 * is unit-testable under node --test without the relay client.
 */

import type { RelayEvent } from "@/shared/api/types";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import { KIND_WEBSITE_HEAD } from "@/shared/constants/kinds";

/** Reuse window: a second mount inside this period never re-queries. */
export const WEBSITE_HEADS_FRESH_MS = 30_000;
/** Rate-limit backoff: stop asking while the connection quota recovers. */
export const WEBSITE_HEADS_RATE_LIMIT_COOLDOWN_MS = 60_000;
/** Other transport failures back off briefly instead of hammering. */
export const WEBSITE_HEADS_ERROR_COOLDOWN_MS = 5_000;

export type WebsiteHeadsLoaderInput = {
  communityId: string;
  channelId: string;
  relaySelfPubkey: string;
};

export type WebsiteHeadsLoaderEnvironment = {
  fetchEvents: (
    filter: RelaySubscriptionFilter,
  ) => Promise<readonly RelayEvent[]>;
  applyEvents: (
    input: WebsiteHeadsLoaderInput,
    events: readonly RelayEvent[],
  ) => void;
  now: () => number;
  setTimer: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
};

type LoaderEntry = {
  input: WebsiteHeadsLoaderInput;
  inFlight: Promise<void> | null;
  loadedAt: number;
  cooldownUntil: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

export function isWebsiteRateLimitError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /rate[- ]?limit|quota exceeded|too many requests/i.test(message);
}

function loaderKey(input: WebsiteHeadsLoaderInput): string {
  return `${input.communityId}\u0000${input.channelId}\u0000${input.relaySelfPubkey}`;
}

export function createWebsiteHeadsLoader(
  environment: WebsiteHeadsLoaderEnvironment,
) {
  const entries = new Map<string, LoaderEntry>();

  function scheduleRetry(entryKey: string, entry: LoaderEntry): void {
    if (entry.retryTimer !== null) return;
    const delay = Math.max(entry.cooldownUntil - environment.now(), 0);
    entry.retryTimer = environment.setTimer(() => {
      entry.retryTimer = null;
      void ensure(entry.input);
    }, delay);
  }

  function ensure(input: WebsiteHeadsLoaderInput): Promise<void> {
    if (
      input.communityId.length === 0 ||
      input.channelId.length === 0 ||
      input.relaySelfPubkey.length === 0
    ) {
      return Promise.resolve();
    }
    const entryKey = loaderKey(input);
    let entry = entries.get(entryKey);
    if (!entry) {
      entry = {
        input,
        inFlight: null,
        loadedAt: 0,
        cooldownUntil: 0,
        retryTimer: null,
      };
      entries.set(entryKey, entry);
    }
    entry.input = input;

    const now = environment.now();
    if (entry.cooldownUntil > now) {
      scheduleRetry(entryKey, entry);
      return Promise.resolve();
    }
    if (entry.inFlight) return entry.inFlight;
    if (entry.loadedAt > 0 && now - entry.loadedAt < WEBSITE_HEADS_FRESH_MS) {
      return Promise.resolve();
    }

    const inFlight = (async () => {
      try {
        const events = await environment.fetchEvents({
          kinds: [KIND_WEBSITE_HEAD],
          "#h": [input.channelId],
          limit: 100,
        });
        environment.applyEvents(input, events);
        entry.loadedAt = environment.now();
        entry.cooldownUntil = 0;
      } catch (error) {
        entry.cooldownUntil =
          environment.now() +
          (isWebsiteRateLimitError(error)
            ? WEBSITE_HEADS_RATE_LIMIT_COOLDOWN_MS
            : WEBSITE_HEADS_ERROR_COOLDOWN_MS);
        scheduleRetry(entryKey, entry);
      } finally {
        entry.inFlight = null;
      }
    })();
    entry.inFlight = inFlight;
    return inFlight;
  }

  function reset(): void {
    for (const entry of entries.values()) {
      if (entry.retryTimer !== null) {
        environment.clearTimer(entry.retryTimer);
        entry.retryTimer = null;
      }
    }
    entries.clear();
  }

  return { ensure, reset };
}

export type WebsiteHeadsLoader = ReturnType<typeof createWebsiteHeadsLoader>;
