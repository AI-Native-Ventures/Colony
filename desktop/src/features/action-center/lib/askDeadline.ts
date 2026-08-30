/**
 * Deadline computed exactly the way `ask_broker.rs::handle_ask` does, for
 * the client-side countdown (resolved question 3: client-side for v1,
 * broker-identical, minute-granularity acceptable).
 *
 * Mirror of two Rust constants (`crates/buzz-core/src/interrupt.rs` and
 * `crates/buzz-relay/src/ask_broker.rs`); keep in sync, do not extend here.
 */

/** Mirror of `buzz_relay::ask_broker::DEFAULT_ASK_WINDOW_SECS`: the window
 * used when neither the ask nor the community names one. */
export const DEFAULT_ASK_WINDOW_SECS = 3600;

/** Mirror of `buzz_core::interrupt::MAX_ASK_WINDOW_SECS`: 30 days. Every
 * window is clamped here regardless of source, matching the broker's
 * defense-in-depth clamp (the ask's own value is already bounded at parse
 * time; the community default is not, until this final clamp). */
export const MAX_ASK_WINDOW_SECS = 30 * 24 * 60 * 60;

/**
 * The deadline the broker stamped (or would stamp) on this ask:
 * `created_at + window_secs`, where `window_secs` is the ask's own
 * `default_window_secs`, else the community's `ask_window_secs` (kind
 * 30179 content), else `DEFAULT_ASK_WINDOW_SECS`, all capped at
 * `MAX_ASK_WINDOW_SECS`.
 *
 * `companyAskWindowSecs` is the raw parsed community value, or `null` when
 * there is no company profile yet, the field is absent/malformed, or it has
 * not loaded — every one of those reads as "no community override" and
 * falls through to `DEFAULT_ASK_WINDOW_SECS`, exactly as
 * `company_ask_window_secs` never fails and never blocks.
 */
export function computeAskDeadline(
  ask: { createdAt: number; defaultWindowSecs: number | null },
  companyAskWindowSecs: number | null,
): number {
  const windowSecs = Math.min(
    ask.defaultWindowSecs ?? companyAskWindowSecs ?? DEFAULT_ASK_WINDOW_SECS,
    MAX_ASK_WINDOW_SECS,
  );
  return ask.createdAt + windowSecs;
}
