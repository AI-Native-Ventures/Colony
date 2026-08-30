import type {
  completeCompanyBlueprint,
  executeCompanyBlueprint,
} from "@/shared/api/companyBlueprint";

/**
 * Running an approved Blueprint to the point where the company exists.
 *
 * The order matters, and it is not the obvious one. Employees and teams are
 * created locally first, then the company is published to the relay. If the
 * relay half fails, the owner is left with a staffed company that has not been
 * announced yet, and retrying finishes it. The other order would leave a
 * company announced to everyone with nobody in it, which reads to the owner as
 * the product having done the work and lost it.
 */
export type ApproveOutcome = {
  status: "created" | "recovered" | "pending-publish";
  companyId: string;
  personaIds: string[];
  teamIds: string[];
  initiativeIds: string[];
  /** Set when the relay half did not finish. Retrying the same approval resumes. */
  publishError?: string;
};

export type ApproveBlueprintInput = {
  blueprint: string;
  requestId: string;
  communityScope: string;
  expectedHash: string;
  relayPubkey: string;
  channelId: string;
  /**
   * The community profile head this approval was prepared against.
   *
   * The relay mints one for every community at boot, so approval always
   * edits that head; a stale one (e.g. an onboarding interview wrote the
   * profile between the read and the click) surfaces as a `pending-publish`
   * outcome, and re-approving reads a fresh head and finishes the write.
   */
  expectedHeadEventId: string;
  expectedHeadCreatedAt: number;
  expectedHeadUpdatedAt: number;
};

type ApproveDependencies = {
  execute: typeof executeCompanyBlueprint;
  complete: typeof completeCompanyBlueprint;
  /** Publish one signed event, resolving to its event ID. */
  publish: (signedEventJson: string) => Promise<string>;
};

/** The event ID shape the backend will accept back. */
const EVENT_ID = /^[0-9a-f]{64}$/;

export function createBlueprintApprover(dependencies: ApproveDependencies) {
  return async function approveBlueprint(
    input: ApproveBlueprintInput,
  ): Promise<ApproveOutcome> {
    const execution = await dependencies.execute(input);

    // The company head is first, and its event ID is what marks the
    // transaction complete.
    let companyEventId: string | undefined;
    try {
      for (const signed of execution.signedActions) {
        const eventId = await dependencies.publish(signed);
        if (companyEventId === undefined) {
          if (!EVENT_ID.test(eventId)) {
            throw new Error("The relay returned an unusable event id.");
          }
          companyEventId = eventId;
        }
      }
    } catch (error) {
      // The employees exist. Saying "failed" would be wrong, and would invite
      // the owner to start over and approve a second time.
      return {
        status: "pending-publish",
        companyId: execution.companyId,
        personaIds: execution.personaIds,
        teamIds: execution.teamIds,
        initiativeIds: execution.initiativeIds,
        publishError:
          error instanceof Error ? error.message : "Publishing failed.",
      };
    }

    if (companyEventId === undefined) {
      return {
        status: "pending-publish",
        companyId: execution.companyId,
        personaIds: execution.personaIds,
        teamIds: execution.teamIds,
        initiativeIds: execution.initiativeIds,
        publishError: "The company was not published.",
      };
    }

    await dependencies.complete({
      requestId: input.requestId,
      communityScope: input.communityScope,
      companyEventId,
    });

    return {
      status: execution.outcome,
      companyId: execution.companyId,
      personaIds: execution.personaIds,
      teamIds: execution.teamIds,
      initiativeIds: execution.initiativeIds,
    };
  };
}
