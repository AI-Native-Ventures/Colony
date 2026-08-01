import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { advanceInitiative } from "@/shared/api/initiative";
import type { InitiativeStepResult } from "@/shared/api/initiative";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_COMPANY_PROFILE,
  KIND_INITIATIVE,
} from "@/shared/constants/kinds";

import { newestHead } from "./contracts";
import { companyActionBroker } from "./workRepository";
import type { CompanyActionBroker } from "./workRepository";

/**
 * Starting an initiative from a click.
 *
 * Starting is a ladder of relay-authored writes, not one: proposed becomes
 * approved, approved becomes active, and an active initiative gets its first
 * Task. Each rung is compare-and-set against the head that was just read, so
 * this re-reads between publishes rather than assuming what the last one
 * produced. A step that does not apply stops the run and says why; the owner
 * clicking again resumes from wherever it actually got to, because every key
 * involved is derived from the initiative rather than generated.
 */

/** Approve, activate, kick off, and one spare rung for a head that moved. */
const MAX_STEPS = 4;

export type StartInitiativeOutcome =
  | {
      status: "started";
      initiativeId: string;
      taskId: string | null;
      owningTeamId: string | null;
    }
  | { status: "declined"; initiativeId: string }
  | { status: "settled"; initiativeId: string; initiativeStatus: string }
  | { status: "blocked"; initiativeId: string; message: string };

export type StartInitiativeInput = {
  initiativeId: string;
  companyId: string;
  intent: "start" | "decline";
};

export type StartInitiativeDependencies = {
  relaySelf: () => Promise<string | null>;
  fetchHead: (
    kind: number,
    id: string,
    relaySelfPubkey: string,
  ) => Promise<RelayEvent | null>;
  advance: (input: {
    companyHead: string;
    initiativeHead: string;
    relayPubkey: string;
    intent: "start" | "decline";
  }) => Promise<InitiativeStepResult>;
  broker: Pick<CompanyActionBroker, "submit">;
};

async function defaultFetchHead(
  kind: number,
  id: string,
  relaySelfPubkey: string,
): Promise<RelayEvent | null> {
  const events = await relayClient.fetchEvents({
    kinds: [kind],
    authors: [relaySelfPubkey],
    "#d": [id],
    limit: 8,
  });
  return newestHead(events);
}

export function createInitiativeStarter(
  dependencies: StartInitiativeDependencies,
) {
  return async function run(
    input: StartInitiativeInput,
  ): Promise<StartInitiativeOutcome> {
    const relayPubkey = await dependencies.relaySelf();
    if (!relayPubkey) {
      throw new Error(
        "This community's relay has no stable identity, so its company records cannot be changed.",
      );
    }

    const companyEvent = await dependencies.fetchHead(
      KIND_COMPANY_PROFILE,
      input.companyId,
      relayPubkey,
    );
    if (!companyEvent) {
      throw new Error("This community has no company record to work under.");
    }
    const companyHead = JSON.stringify(companyEvent);

    for (let attempt = 0; attempt < MAX_STEPS; attempt += 1) {
      // Re-read every rung. The previous publish moved the head, and a second
      // client or a resumed run may have moved it further.
      const initiativeEvent = await dependencies.fetchHead(
        KIND_INITIATIVE,
        input.initiativeId,
        relayPubkey,
      );
      if (!initiativeEvent) {
        throw new Error("That initiative no longer exists on this community.");
      }

      const step = await dependencies.advance({
        companyHead,
        initiativeHead: JSON.stringify(initiativeEvent),
        relayPubkey,
        intent: input.intent,
      });

      if (!step.signedAction) {
        // A declined initiative settles at cancelled, which is the decline
        // having worked rather than a run that found nothing to do.
        if (input.intent === "decline" && step.status === "cancelled") {
          return { status: "declined", initiativeId: input.initiativeId };
        }
        return {
          status: "settled",
          initiativeId: input.initiativeId,
          initiativeStatus: step.status,
        };
      }

      const outcome = await dependencies.broker.submit(step.signedAction);
      if (outcome.status !== "applied") {
        // Nothing here is lost. Every key is derived, so clicking again
        // resumes from whatever the relay actually holds.
        return {
          status: "blocked",
          initiativeId: input.initiativeId,
          message:
            outcome.status === "no-receipt"
              ? outcome.message
              : `${outcome.message} Trying again is safe.`,
        };
      }

      if (step.settled) {
        return input.intent === "decline"
          ? { status: "declined", initiativeId: input.initiativeId }
          : {
              status: "started",
              initiativeId: input.initiativeId,
              taskId: step.taskId,
              owningTeamId: step.owningTeamId,
            };
      }
    }

    return {
      status: "blocked",
      initiativeId: input.initiativeId,
      message:
        "This initiative is still moving between states. Trying again is safe.",
    };
  };
}

export const startInitiative = createInitiativeStarter({
  relaySelf: getRelaySelf,
  fetchHead: defaultFetchHead,
  advance: advanceInitiative,
  broker: companyActionBroker,
});
