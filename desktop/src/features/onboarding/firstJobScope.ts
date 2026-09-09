import { getRelayWsUrl } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import type { FirstJobScope } from "./firstJobStart";

/** Check native identity and destination around each asynchronous handoff step. */
export async function assertFirstJobScope(
  scope: Pick<FirstJobScope, "ownerPubkey" | "relayUrl">,
): Promise<void> {
  const identity = await getIdentity();
  const relayUrl = await getRelayWsUrl();
  const confirmedIdentity = await getIdentity();
  const ready = (value: typeof identity) =>
    value.pubkey === scope.ownerPubkey &&
    !value.locked &&
    !value.lost &&
    !value.resetFailed;
  if (
    !ready(identity) ||
    !ready(confirmedIdentity) ||
    relayUrl !== scope.relayUrl
  ) {
    throw new Error(
      "This account or business has changed. Return to the original business to continue.",
    );
  }
}
