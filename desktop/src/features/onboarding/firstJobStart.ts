/** Maximum owner-authored brief retained for the first-job handoff. */
export const FIRST_JOB_BRIEF_MAX_LENGTH = 4_000;

/** The immutable owner, community and request identity of one handoff. */
export type FirstJobScope = {
  ownerPubkey: string;
  relayUrl: string;
  channelId: string;
  threadRootId: string;
  requestId: string;
};

/** Existing approved actors; selecting them never authorizes new staffing. */
export type FirstJobTeam = { scoutPubkey: string; workerPubkey: string };

/** A send receipt is distinct from a runtime response or completed task. */
export type FirstJobStartResult =
  | { kind: "needs-credits" }
  | { kind: "blocked"; message: string }
  | { kind: "sent"; eventId: string; taskId: string };

/** Native policy, durable retry state and task records stay behind these seams. */
export type FirstJobStartDependencies = {
  assertCurrent(scope: FirstJobScope): Promise<void>;
  ensureConfig(scope: FirstJobScope): Promise<{
    credentialMode: "colony_credits" | "byok";
  }>;
  readAvailableCredits(scope: FirstJobScope): Promise<bigint>;
  /** Read the existing approved setup; never create a profile as a side effect. */
  checkBusiness?(scope: FirstJobScope): Promise<string | null>;
  ensureTeam(scope: FirstJobScope): Promise<FirstJobTeam | null>;
  dispatchOnce(input: {
    scope: FirstJobScope;
    content: string;
    team: FirstJobTeam;
  }): Promise<{ eventId: string; taskId: string }>;
};

/** Capture bounded scope before any asynchronous work can observe mutations. */
export function snapshotFirstJobScope(scope: FirstJobScope): FirstJobScope {
  const snapshot = {
    ownerPubkey: scope.ownerPubkey,
    relayUrl: scope.relayUrl,
    channelId: scope.channelId,
    threadRootId: scope.threadRootId,
    requestId: scope.requestId,
  };
  for (const value of Object.values(snapshot)) {
    if (typeof value !== "string" || !value.trim() || value.length > 2_048)
      throw new Error(
        "The first-job scope is invalid. Reopen this conversation.",
      );
  }
  return Object.freeze(snapshot);
}

/** Collision-free lock key; scope validation belongs before calling this helper. */
export function firstJobScopeKey(scope: FirstJobScope): string {
  return JSON.stringify([
    scope.ownerPubkey,
    scope.relayUrl,
    scope.channelId,
    scope.threadRootId,
    scope.requestId,
  ]);
}

/** Sequence a first-job request without owning native state or task storage. */
export function createFirstJobStarter(dependencies: FirstJobStartDependencies) {
  const inFlight = new Map<string, Promise<FirstJobStartResult>>();

  async function run(
    scope: FirstJobScope,
    content: string,
  ): Promise<FirstJobStartResult> {
    await dependencies.assertCurrent(scope);
    const config = await dependencies.ensureConfig(scope);
    await dependencies.assertCurrent(scope);
    if (config.credentialMode === "colony_credits") {
      const available = await dependencies.readAvailableCredits(scope);
      await dependencies.assertCurrent(scope);
      if (typeof available !== "bigint")
        throw new Error("Available credits could not be read. Try again.");
      if (available <= 0n) return { kind: "needs-credits" };
    } else if (config.credentialMode !== "byok") {
      throw new Error("The teammate configuration is unavailable. Try again.");
    }
    const businessBlock = await dependencies.checkBusiness?.(scope);
    await dependencies.assertCurrent(scope);
    if (businessBlock) return { kind: "blocked", message: businessBlock };
    const team = await dependencies.ensureTeam(scope);
    await dependencies.assertCurrent(scope);
    if (!team) {
      return {
        kind: "blocked",
        message:
          "An approved worker is not available for this job yet. Review your team, then try again.",
      };
    }
    if (
      !team.scoutPubkey?.trim() ||
      !team.workerPubkey?.trim() ||
      team.scoutPubkey.length > 512 ||
      team.workerPubkey.length > 512 ||
      team.scoutPubkey === team.workerPubkey
    ) {
      throw new Error("The worker handoff is unavailable. Try again.");
    }
    const sent = await dependencies.dispatchOnce({
      scope,
      content,
      team: Object.freeze({ ...team }),
    });
    await dependencies.assertCurrent(scope);
    if (!sent.eventId?.trim() || !sent.taskId?.trim())
      throw new Error("The job request could not be confirmed. Try again.");
    return { kind: "sent", eventId: sent.eventId, taskId: sent.taskId };
  }

  return function start(
    inputScope: FirstJobScope,
    inputContent: string,
  ): Promise<FirstJobStartResult> {
    let scope: FirstJobScope;
    let content: string;
    try {
      scope = snapshotFirstJobScope(inputScope);
      content = typeof inputContent === "string" ? inputContent.trim() : "";
      if (!content || content.length > FIRST_JOB_BRIEF_MAX_LENGTH)
        throw new Error(
          `Write a brief of 1 to ${FIRST_JOB_BRIEF_MAX_LENGTH} characters.`,
        );
    } catch (error) {
      return Promise.reject(error);
    }
    const key = firstJobScopeKey(scope);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const operation = run(scope, content).finally(() => inFlight.delete(key));
    inFlight.set(key, operation);
    return operation;
  };
}
