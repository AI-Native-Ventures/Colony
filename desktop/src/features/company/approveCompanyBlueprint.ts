import {
  completeCompanyBlueprint,
  executeCompanyBlueprint,
} from "@/shared/api/companyBlueprint";
import { relayClient } from "@/shared/api/relayClient";
import { getRelaySelf } from "@/features/moderation/lib/relaySelf";

import { createBlueprintApprover } from "./approveBlueprint";
import { postInitiativeCards } from "./postInitiativeCards";

/**
 * Approving a Blueprint from the app.
 *
 * Wires the pieces the orchestration needs and nothing more: the relay's own
 * public key, which is what company records are addressed to, and a publisher
 * for the actions the backend signed.
 */
export type ApproveCompanyBlueprintInput = {
  blueprint: string;
  expectedHash: string;
  requestId: string;
  channelId: string;
};

const approve = createBlueprintApprover({
  execute: executeCompanyBlueprint,
  complete: completeCompanyBlueprint,
  publish: async (signedEventJson) => {
    const event = JSON.parse(signedEventJson);
    const published = await relayClient.publishEvent(
      event,
      "Timed out while creating the company.",
      "The company could not be created.",
    );
    return published.id;
  },
});

export async function approveCompanyBlueprint(
  input: ApproveCompanyBlueprintInput,
) {
  // Company records live at coordinates authored by the relay, so its key is
  // part of the address. Without it there is nothing to approve into.
  const relayPubkey = await getRelaySelf();
  if (!relayPubkey) {
    throw new Error(
      "This community's relay has no stable identity, so a company cannot be created on it.",
    );
  }

  const outcome = await approve({
    blueprint: input.blueprint,
    requestId: input.requestId,
    communityScope: relayPubkey,
    expectedHash: input.expectedHash,
    relayPubkey,
    channelId: input.channelId,
  });

  // The employees exist by now. Saying "failed" would invite approving a
  // second time, so the unfinished half is named for what it is.
  if (outcome.status === "pending-publish") {
    throw new Error(
      outcome.publishError
        ? `Your team was created, but the company could not be announced: ${outcome.publishError} Approving again will finish it.`
        : "Your team was created, but the company could not be announced. Approving again will finish it.",
    );
  }

  // The initiatives now exist as records. A record nobody can see is not a
  // proposal, so the cards that act on them go into the conversation the
  // approval happened in. Posting is idempotent and deliberately not fatal:
  // the company is created either way, and failing here would tell the owner
  // that something went wrong with an approval that fully succeeded.
  try {
    await postInitiativeCards({
      channelId: input.channelId,
    });
  } catch {
    // The initiatives are readable and startable regardless; a card that did
    // not post is a missing prompt, not a missing record.
  }

  return outcome;
}
