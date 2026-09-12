import type {
  CompanyFailureCode,
  CompanyParseResult,
} from "@/features/company/contracts";
import { companyFailure } from "@/features/company/contracts";
import { parseRateLimitHint } from "@/shared/api/relayRateLimitGate";

/**
 * Reading a company record during the first job, on a relay under pressure.
 *
 * The first-job approval path reads the community's company records before it
 * signs anything, and a single failed read used to become a user-facing alert
 * with no approval published. On a loaded runner the relay answers some
 * requests tens of seconds late and refuses others with
 * `rate-limited: quota exceeded; retry in 0s` - a saturated limiter, not a real
 * quota - so that first miss is usually the relay being busy rather than the
 * records being unreadable.
 *
 * Two proof runs of "Native first-job proof" ended the same way for two
 * different upstream reasons: run 34683452482 (develop) raised "Your company
 * profile could not be read" with publishes acknowledged at 184ms and 23957ms,
 * and run 34679336732 raised "Your business setup could not be checked" after
 * two zero-second rate-limit refusals. Neither published an owner approval.
 *
 * So a read here is retried on a short ladder before it becomes an alert. What
 * is *not* retried is a record the relay answered with: a bad signature, a
 * wrong author or malformed content is the same on every attempt, and a read
 * cancelled by a community switch must never be reissued.
 */

/** Attempts per read, including the first. Bounded so a click cannot hang. */
export const FIRST_JOB_READ_ATTEMPTS = 3;
/** First backoff step; doubles per attempt, matching the suggestion-root ladder. */
export const FIRST_JOB_READ_BACKOFF_MS = 150;
/**
 * How long one attempt waits for the relay before it counts as unavailable.
 *
 * The relay client's own history timeout is 25s, which is longer than the whole
 * budget this path has: the packaged proof gives the approval 30s from the
 * click. A shorter per-attempt deadline turns one doomed 25s wait into three
 * chances on a relay that is answering some requests and dropping others.
 */
export const FIRST_JOB_READ_DEADLINE_MS = 6_000;
/**
 * Longest relay-specified cooldown this path will sit out.
 *
 * A hint above this is honest back-pressure that a click cannot wait through,
 * so the read stops and the alert appears rather than the window closing on a
 * retry that was never going to be issued in time.
 */
export const FIRST_JOB_READ_MAX_COOLDOWN_MS = 5_000;

/**
 * Failure codes that mean "the relay was slow or busy", not "these records are
 * unusable". `cancelled` is absent on purpose: the community changed under the
 * read, and a second query would only deliver the old community's records.
 */
const TRANSIENT: ReadonlySet<CompanyFailureCode> = new Set([
  "unavailable",
  "no-relay-identity",
  "missing-head",
]);

/** A timer that can be cancelled once the read it races has resolved. */
export type FirstJobReadDeadline = (ms: number) => {
  expired: Promise<void>;
  cancel(): void;
};

const defaultDeadline: FirstJobReadDeadline = (ms) => {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return {
    expired,
    cancel: () => {
      if (handle !== null) clearTimeout(handle);
    },
  };
};

export type FirstJobReadRetry = { retry: true; waitMs: number } | null;

/**
 * Whether a failed read is worth another attempt, and how long to wait first.
 *
 * A relay-specified cooldown wins over the local backoff when it is longer; a
 * zero or absent cooldown leaves the local backoff in charge, because "retry in
 * 0s" is a limiter with nothing left to give rather than an invitation to
 * retry immediately.
 */
export function firstJobReadRetry<T>(
  result: CompanyParseResult<T>,
  attempt: number,
  options: {
    transient?: ReadonlySet<CompanyFailureCode>;
    backoffMs?: number;
    maxCooldownMs?: number;
  } = {},
): FirstJobReadRetry {
  if (result.ok) return null;
  const transient = options.transient ?? TRANSIENT;
  if (!transient.has(result.code)) return null;
  const hint = parseRateLimitHint(result.message);
  const cooldownMs = hint !== null && hint > 0 ? hint * 1_000 : 0;
  const maxCooldownMs = options.maxCooldownMs ?? FIRST_JOB_READ_MAX_COOLDOWN_MS;
  if (cooldownMs > maxCooldownMs) return null;
  const backoffMs = options.backoffMs ?? FIRST_JOB_READ_BACKOFF_MS;
  return {
    retry: true,
    waitMs: Math.max(backoffMs * 2 ** attempt, cooldownMs),
  };
}

export type FirstJobReadOptions<T> = {
  read(): Promise<CompanyParseResult<T>>;
  /** Re-checked around every attempt, so a switched community stops the ladder. */
  assertCurrent(): Promise<void>;
  delay(ms: number): Promise<void>;
  deadline?: FirstJobReadDeadline;
  attempts?: number;
  deadlineMs?: number;
  transient?: ReadonlySet<CompanyFailureCode>;
  backoffMs?: number;
  maxCooldownMs?: number;
};

/**
 * Read one company record, retrying only a relay that was slow or busy.
 *
 * The last result is returned as-is once the ladder is exhausted, so the caller
 * still raises its own alert: this makes a transient failure survivable, never
 * a real one invisible.
 */
export async function readFirstJobCompanyRecord<T>(
  options: FirstJobReadOptions<T>,
): Promise<CompanyParseResult<T>> {
  const attempts = options.attempts ?? FIRST_JOB_READ_ATTEMPTS;
  const deadlineMs = options.deadlineMs ?? FIRST_JOB_READ_DEADLINE_MS;
  const deadline = options.deadline ?? defaultDeadline;
  let last: CompanyParseResult<T> = companyFailure<T>(
    "unavailable",
    "Company records could not be read: no attempt was made.",
  );
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await options.assertCurrent();
    const timer = deadline(deadlineMs);
    try {
      last = await Promise.race([
        options.read(),
        timer.expired.then(() =>
          companyFailure<T>(
            "unavailable",
            `Company records could not be read: the relay did not answer within ${deadlineMs}ms.`,
          ),
        ),
      ]);
    } finally {
      timer.cancel();
    }
    await options.assertCurrent();
    if (last.ok) return last;
    if (attempt === attempts - 1) break;
    const again = firstJobReadRetry(last, attempt, options);
    if (!again) break;
    await options.delay(again.waitMs);
  }
  return last;
}
