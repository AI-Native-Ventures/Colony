// desktop/src/features/onboarding/membership.ts
import { getMyRelayMembershipLookup } from "@/shared/api/relayMembers";
import { isRelayUnreachableError } from "@/shared/lib/relayError";

/**
 * Whether a relay refused a write because this identity is not a member.
 *
 * The relay says so in four different sentences depending on which layer
 * refused, and a profile save that trips any of them has to offer recovery
 * rather than a raw error.
 */
export function isRelayMembershipDeniedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("You must be a relay member") ||
    error.message.includes("relay_membership_required") ||
    error.message.includes("restricted: not a relay member") ||
    error.message.includes("invalid: you are not a relay member")
  );
}

export type MembershipCheckResult = "denied" | "ok" | "unreachable" | "error";

/**
 * Asks the relay whether this identity may write, before a profile save
 * tries. On an open relay it passes instantly; on a gated one it is what
 * turns a 403 mid-save into a screen that offers a way forward.
 */
export async function checkMembershipStatus(): Promise<MembershipCheckResult> {
  try {
    const { membership, snapshotFound } = await getMyRelayMembershipLookup();
    if (snapshotFound && membership === null) return "denied";
    return "ok";
  } catch (error) {
    if (isRelayMembershipDeniedError(error)) return "denied";
    // Native Tauri commands report connectivity failures with the stable
    // "relay unreachable:" prefix (see desktop/src-tauri/src/relay.rs), which
    // the legacy browser-fetch substrings below do not match.
    if (isRelayUnreachableError(error)) return "unreachable";
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (
        msg.includes("failed to fetch") ||
        msg.includes("networkerror") ||
        msg.includes("timeout") ||
        msg.includes("econnrefused") ||
        msg.includes("enotfound") ||
        msg.includes("connection") ||
        msg.includes("aborted")
      ) {
        return "unreachable";
      }
    }
    return "error";
  }
}
