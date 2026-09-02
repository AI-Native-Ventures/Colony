/**
 * The one thing the Welcome channel must say when a founder arrives with an
 * empty account.
 *
 * Onboarding has a real "Later" on the credits screen and no signup grant
 * behind it, so a founder can land on the hosted Colony Agent runtime with a
 * zero balance. Scout's opener still posts, because the desktop authors that
 * message and no model is involved. Their first reply is where it breaks: the
 * turn reaches the relay's gateway, which answers 402 `insufficient_credits`
 * (`crates/buzz-relay/src/gateway/mod.rs:1224`), and the only surface that
 * carries the denial is the agent's `lastError` in Settings
 * (`friendlyAgentLastError.ts:104`). In the channel it is silence, which
 * reads as a product that does not work rather than an account to top up.
 *
 * Lives outside `welcomeKickoff.ts` because that file is at the repo's
 * 1000-line ceiling.
 */
import { hasManagedAgentChannelMessageMarker } from "@/shared/api/tauriManagedAgentMessageMarkers";
import { sendManagedAgentChannelMessage } from "@/shared/api/tauriManagedAgentMessages";
import {
  getColonyCreditsAccount,
  getColonyCreditsStatus,
} from "@/shared/api/tauriProvisionedCredits";

import { welcomeKickoffMarker } from "@/features/onboarding/devFreshOnboarding";

export const WELCOME_KICKOFF_ZERO_CREDITS_MARKER =
  "buzz-welcome-kickoff.zero-credits.v1";

export const WELCOME_KICKOFF_ZERO_CREDITS_MESSAGE =
  "Scout is ready. Add credits in Billing to let your agents work. Your balance sits beside your profile, and opens Billing when you click it.";

const zeroCreditsMarker = welcomeKickoffMarker(
  WELCOME_KICKOFF_ZERO_CREDITS_MARKER,
);

/**
 * Whether the channel has to say that the agents cannot think yet.
 *
 * An unreadable balance says nothing rather than guessing: telling a founder
 * who has paid that they have not is worse than saying nothing at all. A
 * founder on their own tool is not short of Colony Credits either, because
 * the gateway is not in their path at all.
 */
export function welcomeKickoffNeedsCredits(
  credentialMode: string | null | undefined,
  balanceNanousd: string | null,
): boolean {
  if (credentialMode !== "colony_credits") return false;
  if (balanceNanousd === null) return false;
  return getColonyCreditsStatus(balanceNanousd) === "depleted";
}

/**
 * Post the row that replaces the silence. Marker-scoped to the channel, so it
 * lands once however many times Welcome is revisited.
 */
export async function postZeroCreditsNoticeIfNeeded({
  agentPubkey,
  channelId,
  credentialMode,
  readAccount = getColonyCreditsAccount,
  readMarker = hasManagedAgentChannelMessageMarker,
  send = sendManagedAgentChannelMessage,
}: {
  agentPubkey: string;
  channelId: string;
  credentialMode: string | null | undefined;
  readAccount?: typeof getColonyCreditsAccount;
  readMarker?: typeof hasManagedAgentChannelMessageMarker;
  send?: typeof sendManagedAgentChannelMessage;
}) {
  if (credentialMode !== "colony_credits") return;
  if (
    await readMarker({
      channelId,
      marker: zeroCreditsMarker,
      markerScope: "channel",
    })
  ) {
    return;
  }
  const balance = await readAccount()
    .then((account) => account.balance_nanousd)
    .catch(() => null);
  if (!welcomeKickoffNeedsCredits(credentialMode, balance)) return;
  await send({
    agentPubkey,
    channelId,
    content: WELCOME_KICKOFF_ZERO_CREDITS_MESSAGE,
    marker: zeroCreditsMarker,
    markerScope: "channel",
  });
}
