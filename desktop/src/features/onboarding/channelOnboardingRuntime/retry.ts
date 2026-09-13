import { parseRateLimitHint } from "@/shared/api/relayRateLimitGate";

const DEFAULT_ATTEMPTS = 3;
const MIN_COOLDOWN_MS = 1_000;
const MAX_COOLDOWN_MS = 5_000;

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    if ("message" in value && typeof value.message === "string") {
      return value.message;
    }
    if ("error" in value) return messageOf(value.error);
  }
  return "";
}

/** Return the bounded cooldown for a relay back-pressure response. */
export function rateLimitRetryDelay(
  value: unknown,
  maxCooldownMs = MAX_COOLDOWN_MS,
): number | null {
  const message = messageOf(value);
  if (!message.includes("rate-limited:")) return null;
  const seconds = parseRateLimitHint(message);
  if (seconds === null) return null;
  const cooldownMs = seconds * 1_000;
  if (cooldownMs > maxCooldownMs) return null;
  return Math.max(MIN_COOLDOWN_MS, cooldownMs);
}

/**
 * Retry a read after a short, server-specified relay cooldown.
 *
 * Reads may be repeated because they do not create a new signed action. The
 * caller's scope fence runs around every attempt and before the delay, so a
 * community or owner switch cannot let an old read continue into setup.
 */
export async function readWithRateLimitRetry<T>(options: {
  read: () => Promise<T> | T;
  assertCurrent: () => Promise<void> | void;
  delay: (ms: number) => Promise<void>;
  attempts?: number;
  maxCooldownMs?: number;
}): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await options.assertCurrent();
    try {
      const value = await options.read();
      await options.assertCurrent();
      const cooldownMs = rateLimitRetryDelay(value, options.maxCooldownMs);
      if (cooldownMs === null || attempt === attempts - 1) return value;
      await options.assertCurrent();
      await options.delay(cooldownMs);
    } catch (error) {
      const cooldownMs = rateLimitRetryDelay(error, options.maxCooldownMs);
      if (cooldownMs === null || attempt === attempts - 1) throw error;
      await options.assertCurrent();
      await options.delay(cooldownMs);
    }
  }
  throw new Error("The bounded relay read retry did not complete.");
}
