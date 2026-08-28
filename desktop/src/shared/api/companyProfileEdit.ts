import { invokeTauri } from "./tauri";

/**
 * Editing this community's operating profile.
 *
 * The backend holds the owner's signing key and builds the Company Action
 * envelope, for the same reason every other company write does: the envelope
 * has a canonical encoding the relay validates exactly, and a second
 * implementation of it in TypeScript would agree in every test and diverge on
 * the first real input.
 *
 * This only signs. Submitting, the receipt, and conflict handling stay on the
 * ordinary company-action path so there is one place that knows what a
 * refusal means.
 */
export async function signCommunityProfileUpdate(input: {
  /** The edited profile, exactly as the contract spells it. */
  profile: unknown;
  /**
   * The head the form was populated from.
   *
   * An agent filling the profile in through the onboarding interview writes
   * the same coordinate, so without this compare-and-set an owner pressing
   * Save would silently discard whatever landed while the form was open.
   */
  expectedHeadEventId: string;
  relayPubkey: string;
  requestId: string;
}): Promise<string> {
  return invokeTauri<string>("sign_community_profile_update", {
    profile: JSON.stringify(input.profile),
    expectedHeadEventId: input.expectedHeadEventId,
    relayPubkey: input.relayPubkey,
    requestId: input.requestId,
  });
}
