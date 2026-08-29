import type { RelayEvent } from "@/shared/api/types";
import { KIND_COMPANY_PROFILE } from "@/shared/constants/kinds";

/**
 * The community's `ask_window_secs` override, read straight off the company
 * profile head's raw JSON content (kind 30179), exactly like the relay's own
 * `company_ask_window_secs` (`ask_broker.rs`): tolerant of any other fields
 * the same head carries, and `null` (never a fallback constant) when there
 * is no head yet, or the field is absent or not a non-negative integer.
 * Callers apply `DEFAULT_ASK_WINDOW_SECS` themselves via
 * `computeAskDeadline`, so there is exactly one place owning that fallback.
 *
 * Deliberately does NOT go through `parseCompanyHead` / `CompanyProfile`:
 * that parser requires the content's keys to match the business-profile
 * schema exactly (`matchesShape`'s `present.length !== declared.length`),
 * so a head that also carries `ask_window_secs` would fail that parse
 * entirely. The relay itself never applies that schema check when reading
 * this field, so this reader mirrors the relay's permissiveness instead.
 */
export function readCompanyAskWindowSecs(
  events: readonly RelayEvent[],
  relayPubkey: string | null,
): number | null {
  if (!relayPubkey) return null;
  const normalizedRelayPubkey = relayPubkey.trim().toLowerCase();
  const stored = events.find(
    (event) =>
      event.kind === KIND_COMPANY_PROFILE &&
      event.pubkey.trim().toLowerCase() === normalizedRelayPubkey,
  );
  if (!stored) return null;
  let content: unknown;
  try {
    content = JSON.parse(stored.content);
  } catch {
    return null;
  }
  if (!content || typeof content !== "object") return null;
  const value = (content as Record<string, unknown>).ask_window_secs;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}
