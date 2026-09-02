import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import type { UserInitiativeResult } from "@/shared/api/initiative";
import { createInitiative } from "@/shared/api/initiative";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_COMPANY_PROFILE } from "@/shared/constants/kinds";

import { companyRepository } from "./companyRepository";
import type { CompanyParseResult, Initiative } from "./contracts";
import { COMMUNITY_PROFILE_ID, newestHead } from "./contracts";
import { validateNewInitiativeInput } from "./newInitiativeModel";
import { companyActionBroker } from "./workRepository";
import type { CompanyActionBroker } from "./workRepository";

/**
 * Creating an initiative by hand from a "New initiative" affordance, rather
 * than one blueprint approval or a template fan-out proposes.
 *
 * Same shape as `createTask.ts`: the desktop never signs a company head, it
 * asks the backend what to publish and then waits for the relay's own receipt
 * before treating anything as created.
 */

const DEFAULT_READBACK_ATTEMPTS = 8;
const DEFAULT_READBACK_INTERVAL_MS = 300;

export type CreateInitiativeRequest = {
  channelId: string;
  title: string;
  summary: string;
  costCentreId: string;
  /**
   * This client's stable identity for this create attempt. A retry (a lost
   * receipt, resubmitting after a failure) reuses it; a fresh "create" click
   * mints a new one - reusing one across two different attempts would ask
   * the backend to update the first initiative instead of creating a second.
   */
  requestId: string;
};

export type CreateInitiativeDependencies = {
  relaySelf: () => Promise<string | null>;
  fetchCompanyHead: (relaySelfPubkey: string) => Promise<RelayEvent | null>;
  createInitiative: (input: {
    companyHead: string;
    requestId: string;
    channelId: string;
    title: string;
    summary: string | null;
    costCentreId: string;
    relayPubkey: string;
  }) => Promise<UserInitiativeResult>;
  broker: Pick<CompanyActionBroker, "submit">;
  loadInitiative: (
    initiativeId: string,
  ) => Promise<CompanyParseResult<Initiative>>;
  delay?: (ms: number) => Promise<void>;
  readBackAttempts?: number;
  readBackIntervalMs?: number;
};

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

export function createInitiativeCreator(
  dependencies: CreateInitiativeDependencies,
) {
  return async function run(
    request: CreateInitiativeRequest,
  ): Promise<Initiative> {
    const validation = validateNewInitiativeInput(request);
    if (!validation.ok) {
      throw new Error(validation.message);
    }

    const relayPubkey = await dependencies.relaySelf();
    if (!relayPubkey) {
      throw new Error(
        "This community's relay has no stable identity, so this initiative cannot be recorded against it.",
      );
    }

    const companyEvent = await dependencies.fetchCompanyHead(relayPubkey);
    if (!companyEvent) {
      throw new Error(
        "This community has not described its business yet, so this initiative has no cost centre to charge.",
      );
    }

    const planned = await dependencies.createInitiative({
      companyHead: JSON.stringify(companyEvent),
      requestId: request.requestId,
      channelId: validation.channelId,
      title: validation.title,
      summary: validation.summary,
      costCentreId: validation.costCentreId,
      relayPubkey,
    });

    const outcome = await dependencies.broker.submit(planned.signedAction);
    // A conflict means an initiative with this request id already exists,
    // which is the state a retry was trying to reach. A superseded submission
    // means the relay's idempotency claim on this request id was already won,
    // most likely by an earlier attempt at this exact create - the id is
    // derived from `requestId`, not from which event won the claim, so it
    // names the same initiative either way.
    if (
      outcome.status !== "applied" &&
      outcome.status !== "conflict" &&
      outcome.status !== "superseded"
    ) {
      throw new Error(outcome.message);
    }

    // The receipt already confirms the write, so a head that is not there yet
    // is the relay's index lagging it rather than the initiative being
    // absent. Returning without waiting would refresh the list before the new
    // row exists in it, which reads as a create that silently did nothing.
    //
    // Only `missing-head` is that lag. A head that will not parse, a relay
    // with no identity, and a read cancelled by a community switch are all
    // answers that cannot change within the budget, so retrying them spends
    // it and then reports the one thing they are not.
    const attempts = dependencies.readBackAttempts ?? DEFAULT_READBACK_ATTEMPTS;
    const intervalMs =
      dependencies.readBackIntervalMs ?? DEFAULT_READBACK_INTERVAL_MS;
    const wait = dependencies.delay ?? defaultDelay;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const found = await dependencies.loadInitiative(planned.initiativeId);
      if (found.ok) {
        return found.value;
      }
      if (found.code !== "missing-head") {
        throw new Error(found.message);
      }
      if (attempt + 1 < attempts) {
        await wait(intervalMs);
      }
    }
    throw new Error(
      "The initiative was recorded but could not be read back. Trying again is safe.",
    );
  };
}

export const createInitiativeFromForm = createInitiativeCreator({
  relaySelf: getRelaySelf,
  fetchCompanyHead: async (relaySelfPubkey) =>
    newestHead(
      await relayClient.fetchEvents({
        kinds: [KIND_COMPANY_PROFILE],
        authors: [relaySelfPubkey],
        "#d": [COMMUNITY_PROFILE_ID],
        limit: 8,
      }),
    ),
  createInitiative,
  broker: companyActionBroker,
  loadInitiative: (initiativeId) =>
    companyRepository.getInitiative(initiativeId),
});
