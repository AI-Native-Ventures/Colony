import { companyRepository } from "@/features/company/companyRepository";
import type {
  CompanyParseResult,
  CompanyProfile,
} from "@/features/company/contracts";
import {
  createCompanyActionBroker,
  parseCompanyReceipt,
  type CompanyActionOutcome,
} from "@/features/company/workRepository";
import { ensureWelcomeCanvas } from "@/features/onboarding/welcomeCanvas";
import { ensureWelcomeTeam } from "@/features/onboarding/welcomeGuide";
import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { getRelayWsUrl, signRelayEvent } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { relayClient } from "@/shared/api/relayClient";
import type { ManagedAgentRuntimeStatus, RelayEvent } from "@/shared/api/types";
import {
  KIND_COMPANY_RECEIPT,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
} from "@/shared/constants/kinds";
import { signCommunityProfileUpdate } from "@/shared/api/companyProfileEdit";
import { startManagedAgentRuntime } from "@/shared/api/tauriManagedAgents";

import type {
  ScoutSetupInput,
  ScoutSetupProof,
} from "./channelOnboarding/types";
import {
  assertScoutAcknowledgementEvent,
  assertScoutOnboardingRoot,
  assertScoutProfileAction,
  assertScoutSetupProof,
  assertScoutSignedRootEnvelope,
  buildScoutCompanyProfile,
  parseSignedScoutEvent,
  sameScoutSetupInput,
  snapshotScoutSetupInput,
  type ChannelOnboardingScope,
} from "./channelOnboardingSetup";
import {
  assertAttemptMatches,
  assertProfileReceiptForAttempt,
  assertSavedProfileAction,
  runtimeIsUsable,
  teamScout,
  validAcknowledgement,
  validAttempt,
  type ScoutAcknowledgement,
  type ScoutAttemptStore,
  type ScoutOnboardingAttempt,
  type ScoutProfileReceipt,
  type ScoutRuntimeTeam,
} from "./channelOnboardingRuntime/attempt";
import { createScoutAcknowledgementDelivery } from "./channelOnboardingRuntime/acknowledgement";
import { createScoutReplyVerifier } from "./channelOnboardingRuntime/reply";
import {
  createChannelOnboardingBrowserStore,
  SCOUT_ONBOARDING_ATTEMPT_SLOT,
  snapshotChannelOnboardingScope,
} from "./channelOnboardingStorage";
const APPROVAL_REQUEST_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export type {
  ScoutAcknowledgement,
  ScoutOnboardingAttempt,
  ScoutProfileReceipt,
  ScoutRuntimeTeam,
  ScoutSetupAttemptPhase,
} from "./channelOnboardingRuntime/attempt";

export type ScoutAcknowledgementInput = {
  scope: ChannelOnboardingScope;
  input: ScoutSetupInput;
  requestId: string;
  scoutPubkey: string;
  attempt: ScoutOnboardingAttempt;
  /** Existing signed event to republish after an uncertain delivery. */
  existingAcknowledgement?: ScoutAcknowledgement | null;
};

export type ScoutAcknowledgementResult = {
  eventId: string;
  /** The delivery layer may return the exact event or its serialized JSON. */
  signedEvent?: string | RelayEvent;
  /** A signed relay receipt, when the protocol has one. */
  receiptEventId?: string;
  /** Default delivery sets this only after the relay accepts the event. */
  published?: boolean;
};

export type ScoutReplyVerificationInput = {
  scope: ChannelOnboardingScope;
  input: ScoutSetupInput;
  requestId: string;
  scoutPubkey: string;
  acknowledgement: ScoutAcknowledgement;
  attempt: ScoutOnboardingAttempt;
  acknowledgementEvent?: RelayEvent;
};

export type ChannelOnboardingRuntimeDependencies = {
  /** Load the exact root from the active relay, including its signature. */
  loadOriginalRoot?: (
    scope: ChannelOnboardingScope,
  ) => Promise<RelayEvent | null>;
  /** Protocol-specific accepted-snapshot validation owned by the architecture slice. */
  validateOriginalRoot?: (
    root: RelayEvent,
    scope: ChannelOnboardingScope,
    input: ScoutSetupInput,
  ) => Promise<void> | void;
  assertCurrent?: (scope: ChannelOnboardingScope) => Promise<void> | void;
  getRelaySelf?: () => Promise<string | null>;
  getCompanyHead?: () => Promise<
    CompanyParseResult<{ profile: CompanyProfile; headEventId: string }>
  >;
  signCompanyProfileUpdate?: typeof signCommunityProfileUpdate;
  submitCompanyAction?: (signedAction: string) => Promise<CompanyActionOutcome>;
  readCompanyActionReceipt?: (
    actionEventId: string,
    relayPubkey: string,
    scope: ChannelOnboardingScope,
  ) => Promise<ScoutProfileReceipt | null>;
  ensureCanvas?: (channelId: string) => Promise<boolean>;
  ensureTeam?: (
    channelId: string,
    relayUrl: string,
  ) => Promise<ScoutRuntimeTeam>;
  startRuntime?: (
    pubkey: string,
    relayUrl: string,
    expectedOwnerPubkey: string,
  ) => Promise<ManagedAgentRuntimeStatus>;
  deliverAcknowledgement?: (
    input: ScoutAcknowledgementInput,
  ) => Promise<ScoutAcknowledgementResult>;
  loadAcknowledgementEvent?: (
    eventId: string,
    scope: ChannelOnboardingScope,
  ) => Promise<RelayEvent | null>;
  validateAcknowledgement?: (
    event: RelayEvent,
    scope: ChannelOnboardingScope,
    input: ScoutSetupInput,
    acknowledgementEventId: string,
    approvalRequestId?: string,
  ) => Promise<void> | void;
  verifyScoutReply?: (
    input: ScoutReplyVerificationInput,
  ) => Promise<ScoutSetupProof>;
  validateProof?: (
    proof: ScoutSetupProof,
    scope: ChannelOnboardingScope,
    scoutPubkey: string,
    acknowledgementEventId: string,
    approvalRequestId?: string,
  ) => Promise<void> | void;
  /** Stable clock seam for focused tests; production uses wall clock time. */
  now?: () => number;
  attemptStore?: ScoutAttemptStore;
};

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultStore(): ScoutAttemptStore {
  return createChannelOnboardingBrowserStore(
    SCOUT_ONBOARDING_ATTEMPT_SLOT,
    validAttempt,
  );
}

async function defaultAssertCurrent(scope: ChannelOnboardingScope) {
  const first = await getIdentity();
  const relay = await getRelayWsUrl();
  const second = await getIdentity();
  const sameOwner = (value: typeof first) =>
    value.pubkey.toLowerCase() === scope.ownerPubkey.toLowerCase() &&
    value.locked !== true &&
    value.lost !== true &&
    value.resetFailed !== true;
  if (!sameOwner(first) || !sameOwner(second) || relay !== scope.relayUrl) {
    throw new Error(
      "This account or business changed. Return to the original Welcome thread to continue.",
    );
  }
}

async function defaultRootLoader(scope: ChannelOnboardingScope) {
  return relayClient.fetchFirstEvent({
    ids: [scope.threadRootId],
    kinds: [KIND_STREAM_MESSAGE, KIND_STREAM_MESSAGE_V2],
    authors: [scope.ownerPubkey],
    "#h": [scope.channelId],
    limit: 1,
  });
}

function defaultCompanyHead() {
  return companyRepository.getActiveCompanyHead();
}

function defaultActionSubmit(scope: ChannelOnboardingScope) {
  return createCompanyActionBroker({
    relaySelf: getRelaySelf,
    publish: (event) =>
      relayClient.publishEvent(
        event,
        "Your business update is awaiting confirmation. Retry the saved update.",
        "Your business details could not be saved. Try again.",
        scope.relayUrl,
      ),
    fetchFirstEvent: (filter) => relayClient.fetchFirstEvent(filter),
  });
}

async function defaultReadCompanyActionReceipt(
  actionEventId: string,
  relayPubkey: string,
): Promise<ScoutProfileReceipt | null> {
  const event = await relayClient.fetchFirstEvent({
    kinds: [KIND_COMPANY_RECEIPT],
    authors: [relayPubkey],
    "#e": [actionEventId],
    limit: 1,
  });
  if (!event) return null;
  const receipt = parseCompanyReceipt(event, relayPubkey, actionEventId);
  if (receipt?.outcome !== "applied" || !receipt.headEventId) {
    return null;
  }
  return {
    receiptEventId: receipt.receiptEventId,
    actionEventId: receipt.actionEventId,
    requestId: receipt.requestId,
    headEventId: receipt.headEventId,
    target: receipt.target,
  };
}

function invalidCompanyHead(result: CompanyParseResult<unknown>): never {
  throw new Error(
    result.ok
      ? "The company profile could not be read."
      : `The company profile could not be read: ${result.message}`,
  );
}

function acknowledgementSnapshot(
  result: ScoutAcknowledgementResult,
): ScoutAcknowledgement {
  if (
    !result ||
    typeof result.eventId !== "string" ||
    result.eventId.trim() === ""
  ) {
    throw new Error("The Scout acknowledgment did not return an event id.");
  }
  const signedEvent =
    result.signedEvent === undefined
      ? undefined
      : typeof result.signedEvent === "string"
        ? result.signedEvent
        : JSON.stringify(result.signedEvent);
  return {
    eventId: result.eventId,
    ...(signedEvent === undefined ? {} : { signedEvent }),
    // A custom delivery must explicitly say that the relay accepted the
    // event. An omitted flag is an unresolved delivery, never readiness.
    published: result.published === true,
    ...(result.receiptEventId === undefined
      ? {}
      : { receiptEventId: result.receiptEventId }),
  };
}

/**
 * Orchestrate the owner-approved, Scout-only setup path.
 *
 * The signed company action and acknowledgment are written to durable storage
 * before publication. Every retry reuses those exact signed events; the only
 * stages that may be repeated are idempotent reads, Welcome provisioning,
 * runtime start, and response verification.
 */
export function createChannelOnboardingRuntime(
  inputScope: ChannelOnboardingScope,
  dependencies: ChannelOnboardingRuntimeDependencies = {},
) {
  const scope = snapshotChannelOnboardingScope(inputScope);
  const store = dependencies.attemptStore ?? defaultStore();
  const assertCurrent = dependencies.assertCurrent ?? defaultAssertCurrent;
  const loadRoot = dependencies.loadOriginalRoot ?? defaultRootLoader;
  const getSelf = dependencies.getRelaySelf ?? getRelaySelf;
  const getHead = dependencies.getCompanyHead ?? defaultCompanyHead;
  const sign =
    dependencies.signCompanyProfileUpdate ?? signCommunityProfileUpdate;
  const ensureCanvas = dependencies.ensureCanvas ?? ensureWelcomeCanvas;
  const ensureTeam = dependencies.ensureTeam ?? ensureWelcomeTeam;
  const startRuntime = dependencies.startRuntime ?? startManagedAgentRuntime;
  const now = dependencies.now ?? Date.now;
  const readReceipt =
    dependencies.readCompanyActionReceipt ??
    ((actionEventId: string, relayPubkey: string) =>
      defaultReadCompanyActionReceipt(actionEventId, relayPubkey));
  const submit =
    dependencies.submitCompanyAction ??
    ((signed: string) => defaultActionSubmit(scope).submit(signed));
  const verifyReply =
    dependencies.verifyScoutReply ??
    createScoutReplyVerifier({ assertCurrent });

  async function current<T>(operation: () => Promise<T> | T) {
    await assertCurrent(scope);
    const result = await operation();
    await assertCurrent(scope);
    return result;
  }

  async function loadAndValidateRoot(input: ScoutSetupInput) {
    const root = await current(() => loadRoot(scope));
    // The cryptographic/scope envelope is always checked here. The protocol
    // agent can add its accepted-snapshot rules without weakening this check.
    assertScoutSignedRootEnvelope(scope, root);
    if (!root) {
      throw new Error(
        "The original Scout approval could not be found. Reopen its Welcome thread.",
      );
    }
    // The extension point may add protocol-specific acceptance rules, but it
    // cannot turn an old or malformed root into authorization for this new
    // setup path.
    assertScoutOnboardingRoot(scope, root, input);
    if (dependencies.validateOriginalRoot) {
      await dependencies.validateOriginalRoot(root, scope, input);
    }
    return root;
  }

  async function validateStoredAcknowledgement(
    attempt: ScoutOnboardingAttempt,
    input: ScoutSetupInput,
  ) {
    const saved = attempt.acknowledgement;
    if (!saved || !validAcknowledgement(saved)) {
      throw new Error("The saved Scout acknowledgment is incomplete.");
    }
    if (saved.published !== true) {
      throw new Error(
        "The saved Scout acknowledgment was not confirmed by the relay. Retry the same request.",
      );
    }
    let event: RelayEvent | null = null;
    if (saved.signedEvent) {
      event = parseSignedScoutEvent(saved.signedEvent);
    } else if (dependencies.loadAcknowledgementEvent) {
      const loadAcknowledgementEvent = dependencies.loadAcknowledgementEvent;
      event = await current(() =>
        loadAcknowledgementEvent(saved.eventId, scope),
      );
    }
    if (!event) {
      throw new Error(
        "The saved Scout acknowledgment cannot be verified. No new request has been sent.",
      );
    }
    if (dependencies.validateAcknowledgement) {
      await dependencies.validateAcknowledgement(
        event,
        scope,
        input,
        saved.eventId,
        attempt.approvalRequestId,
      );
    } else {
      assertScoutAcknowledgementEvent(
        event,
        scope,
        input,
        saved.eventId,
        attempt.approvalRequestId,
        attempt.scoutPubkey ?? undefined,
      );
    }
    return event;
  }

  async function approve(
    input: ScoutSetupInput,
    requestId: string,
  ): Promise<ScoutSetupProof> {
    const reviewed = snapshotScoutSetupInput(input);
    if (
      typeof requestId !== "string" ||
      !APPROVAL_REQUEST_ID.test(requestId) ||
      requestId.toLowerCase() === scope.requestId.toLowerCase()
    ) {
      throw new Error(
        "This Scout setup approval needs a new request id separate from signup.",
      );
    }
    return store.withLock(scope, async () => {
      await assertCurrent(scope);
      let attempt = store.read(scope);
      let root: RelayEvent | null = null;
      if (attempt) {
        if (!validAttempt(attempt)) {
          throw new Error(
            "The saved Scout setup could not be verified. No new request was sent.",
          );
        }
        root = await loadAndValidateRoot(reviewed);
        if (sameScoutSetupInput(attempt.input, reviewed)) {
          assertAttemptMatches(attempt, scope, reviewed, root);
          assertSavedProfileAction(attempt, scope, reviewed);
          if (attempt.phase === "ready") {
            if (
              !attempt.profileReceipt ||
              !attempt.scoutPubkey ||
              !attempt.runtimeStatus ||
              !attempt.acknowledgement ||
              !attempt.proof ||
              !runtimeIsUsable(
                attempt.runtimeStatus,
                attempt.scoutPubkey,
                scope.relayUrl,
              )
            ) {
              throw new Error(
                "The saved Scout setup is incomplete. No new setup was started.",
              );
            }
            assertProfileReceiptForAttempt(attempt.profileReceipt, attempt);
            await validateStoredAcknowledgement(attempt, attempt.input);
            if (dependencies.validateProof) {
              await dependencies.validateProof(
                attempt.proof,
                scope,
                attempt.scoutPubkey,
                attempt.acknowledgement.eventId,
                attempt.approvalRequestId,
              );
            } else {
              assertScoutSetupProof(
                attempt.proof,
                scope,
                attempt.scoutPubkey,
                attempt.acknowledgement.eventId,
                attempt.approvalRequestId,
              );
            }
            return clone(attempt.proof);
          }
        } else if (attempt.phase !== "ready") {
          throw new Error(
            "The previous Scout setup is still being resolved. Retry it before approving a changed snapshot.",
          );
        } else {
          // A completed setup may receive a later owner-approved snapshot. Its
          // new approval UUID gets a new signed action; an unfinished attempt
          // above is never overwritten while its receipt is uncertain.
          attempt = null;
        }
      }
      if (!attempt) {
        root ??= await loadAndValidateRoot(reviewed);
        if (!root) {
          throw new Error(
            "The original Scout approval could not be found. Reopen its Welcome thread.",
          );
        }
        const relayPubkey = await current(getSelf);
        if (!relayPubkey) {
          throw new Error(
            "This business connection has no stable relay identity.",
          );
        }
        const head = await current(getHead);
        if (!head.ok) invalidCompanyHead(head);
        const built = buildScoutCompanyProfile(
          head.value.profile,
          reviewed,
          Math.floor(now() / 1_000),
        );
        const signed = await current(() =>
          sign({
            profile: built.profile,
            expectedHeadEventId: head.value.headEventId,
            relayPubkey,
            // The root's request id identifies signup delivery. The approval
            // UUID identifies this exact reviewed setup and is reused after a
            // retry, so the company action remains idempotent per approval.
            requestId,
            expectedOwnerPubkey: scope.ownerPubkey,
            expectedRelayUrl: scope.relayUrl,
          }),
        );
        const action = parseSignedScoutEvent(signed);
        assertScoutProfileAction(
          action,
          scope,
          reviewed,
          built.profile,
          head.value.headEventId,
          requestId,
          relayPubkey,
        );
        attempt = {
          version: 1,
          scope,
          approvalRequestId: requestId,
          input: reviewed,
          rootEvent: root,
          websiteState: built.websiteState,
          relayPubkey,
          expectedHeadEventId: head.value.headEventId,
          profile: built.profile,
          signedProfileAction: signed,
          profileActionEventId: action.id,
          profileReceipt: null,
          welcomeChannelId: scope.channelId,
          scoutPubkey: null,
          runtimeStatus: null,
          acknowledgement: null,
          proof: null,
          phase: "profile-signed",
        };
        if (!validAttempt(attempt)) {
          throw new Error(
            "The approved Scout setup could not be saved safely.",
          );
        }
        // The event is durable before any network publication can occur.
        store.write(scope, attempt);
      }

      const saved = attempt;
      if (saved.profileReceipt) {
        assertProfileReceiptForAttempt(saved.profileReceipt, saved);
        const confirmed = await current(() =>
          readReceipt(saved.profileActionEventId, saved.relayPubkey, scope),
        );
        if (!confirmed) {
          throw new Error(
            "The saved company receipt could not be verified. Retry this setup to check the same update.",
          );
        }
        assertProfileReceiptForAttempt(confirmed, saved);
        saved.profileReceipt = confirmed;
        store.write(scope, saved);
      } else {
        const outcome = await current(() => submit(saved.signedProfileAction));
        if (outcome.status !== "applied") {
          if (outcome.status === "no-receipt") {
            throw new Error(
              "Your business update is awaiting confirmation. Retry this saved Scout setup to check the same update.",
            );
          }
          throw new Error(
            "message" in outcome
              ? outcome.message
              : "The saved business update was superseded. Review Company settings before retrying.",
          );
        }
        saved.profileReceipt = {
          receiptEventId: outcome.receiptEventId,
          actionEventId: saved.profileActionEventId,
          requestId: saved.approvalRequestId,
          headEventId: outcome.headEventId,
          target: outcome.target,
        };
        assertProfileReceiptForAttempt(saved.profileReceipt, saved);
        saved.phase = "profile-applied";
        store.write(scope, saved);
      }

      if (!saved.scoutPubkey) {
        await current(() => ensureCanvas(saved.welcomeChannelId));
        const team = await current(() =>
          ensureTeam(saved.welcomeChannelId, scope.relayUrl),
        );
        const scout = teamScout(team);
        saved.scoutPubkey = scout.pubkey;
        saved.phase = "team-ready";
        store.write(scope, saved);
      }
      const scoutPubkey = saved.scoutPubkey;
      if (!scoutPubkey)
        throw new Error("Scout setup has no Chief of Staff identity.");

      const runtimeStatus = await current(() =>
        startRuntime(scoutPubkey, scope.relayUrl, scope.ownerPubkey),
      );
      if (!runtimeIsUsable(runtimeStatus, scoutPubkey, scope.relayUrl)) {
        throw new Error(
          runtimeStatus.error ?? "Scout could not start its real runtime.",
        );
      }
      saved.runtimeStatus = runtimeStatus;
      store.write(scope, saved);

      const acknowledgementNeedsPublish =
        saved.acknowledgement?.published !== true;
      if (acknowledgementNeedsPublish) {
        const deliverAcknowledgement = dependencies.deliverAcknowledgement;
        const delivered = deliverAcknowledgement
          ? await current(() =>
              deliverAcknowledgement({
                scope,
                input: reviewed,
                requestId: saved.approvalRequestId,
                scoutPubkey,
                attempt: saved,
                existingAcknowledgement: saved.acknowledgement,
              }),
            )
          : await current(() => {
              const deliver = createScoutAcknowledgementDelivery({
                sign: signRelayEvent,
                assertCurrent,
                persistBeforePublish: (acknowledgement) => {
                  saved.acknowledgement = acknowledgement;
                  saved.phase = "acknowledgement-signed";
                  store.write(scope, saved);
                },
                persistAfterPublish: (acknowledgement) => {
                  saved.acknowledgement = acknowledgement;
                  store.write(scope, saved);
                },
                now,
              });
              const existing = saved.acknowledgement
                ? {
                    eventId: saved.acknowledgement.eventId,
                    signedEvent: saved.acknowledgement.signedEvent ?? "",
                    published: saved.acknowledgement.published === true,
                    ...(saved.acknowledgement.receiptEventId
                      ? { receiptEventId: saved.acknowledgement.receiptEventId }
                      : {}),
                  }
                : null;
              return deliver({
                scope,
                input: reviewed,
                approvalRequestId: saved.approvalRequestId,
                scoutPubkey,
                existing,
              });
            });
        const acknowledgement = acknowledgementSnapshot(delivered);
        if (acknowledgement.published !== true) {
          // The exact signed event is already durable; waiting for a relay
          // receipt is the only safe next step. In particular, do not start a
          // response proof from an event whose publication is uncertain.
          throw new Error(
            "The Scout acknowledgment was signed but not confirmed by the relay. Retry the same request.",
          );
        }
        let event: RelayEvent | null = null;
        if (acknowledgement.signedEvent) {
          event = parseSignedScoutEvent(acknowledgement.signedEvent);
        } else if (dependencies.loadAcknowledgementEvent) {
          const loadAcknowledgementEvent =
            dependencies.loadAcknowledgementEvent;
          event = await current(() =>
            loadAcknowledgementEvent(acknowledgement.eventId, scope),
          );
        }
        if (!event) {
          throw new Error(
            "The signed Scout acknowledgment was not returned. No readiness was recorded.",
          );
        }
        if (dependencies.validateAcknowledgement) {
          await dependencies.validateAcknowledgement(
            event,
            scope,
            reviewed,
            acknowledgement.eventId,
            saved.approvalRequestId,
          );
        } else {
          assertScoutAcknowledgementEvent(
            event,
            scope,
            reviewed,
            acknowledgement.eventId,
            saved.approvalRequestId,
            scoutPubkey,
          );
        }
        saved.acknowledgement = acknowledgement;
        saved.phase = "acknowledgement-signed";
        store.write(scope, saved);
      } else {
        await validateStoredAcknowledgement(saved, reviewed);
      }

      const acknowledgement = saved.acknowledgement;
      if (!acknowledgement) {
        throw new Error("Scout setup has no signed acknowledgment to verify.");
      }
      const acknowledgementEvent = acknowledgement.signedEvent
        ? parseSignedScoutEvent(acknowledgement.signedEvent)
        : undefined;

      if (saved.proof) {
        if (dependencies.validateProof) {
          await dependencies.validateProof(
            saved.proof,
            scope,
            scoutPubkey,
            acknowledgement.eventId,
            saved.approvalRequestId,
          );
        } else {
          assertScoutSetupProof(
            saved.proof,
            scope,
            scoutPubkey,
            acknowledgement.eventId,
            saved.approvalRequestId,
          );
        }
        return saved.proof;
      }
      const proof = await current(() =>
        verifyReply({
          scope,
          input: reviewed,
          requestId: saved.approvalRequestId,
          scoutPubkey,
          acknowledgement,
          attempt: saved,
          acknowledgementEvent,
        }),
      );
      if (dependencies.validateProof) {
        await dependencies.validateProof(
          proof,
          scope,
          scoutPubkey,
          acknowledgement.eventId,
          saved.approvalRequestId,
        );
      } else {
        assertScoutSetupProof(
          proof,
          scope,
          scoutPubkey,
          acknowledgement.eventId,
          saved.approvalRequestId,
        );
      }
      saved.proof = clone(proof);
      saved.phase = "ready";
      store.write(scope, saved);
      return proof;
    });
  }

  /** Revalidate a completed attempt after reload without starting or publishing anything. */
  async function reconcileSavedProof(
    input: ScoutSetupInput,
  ): Promise<ScoutSetupProof | null> {
    const reviewed = snapshotScoutSetupInput(input);
    return current(async () => {
      const attempt = store.read(scope);
      if (!attempt) return null;
      if (!validAttempt(attempt)) {
        throw new Error(
          "The saved Scout setup could not be verified. No new request was sent.",
        );
      }
      const root = await loadAndValidateRoot(reviewed);
      assertAttemptMatches(attempt, scope, reviewed, root);
      if (attempt.phase !== "ready") return null;
      if (
        !attempt.profileReceipt ||
        !attempt.scoutPubkey ||
        !attempt.runtimeStatus ||
        !attempt.acknowledgement ||
        !attempt.proof ||
        !runtimeIsUsable(
          attempt.runtimeStatus,
          attempt.scoutPubkey,
          scope.relayUrl,
        )
      ) {
        throw new Error(
          "The saved Scout setup is incomplete. Retry the same request.",
        );
      }
      assertSavedProfileAction(attempt, scope, reviewed);
      assertProfileReceiptForAttempt(attempt.profileReceipt, attempt);
      const receipt = await readReceipt(
        attempt.profileActionEventId,
        attempt.relayPubkey,
        scope,
      );
      if (!receipt) {
        throw new Error(
          "The saved company receipt could not be verified. Retry this setup to check the same update.",
        );
      }
      assertProfileReceiptForAttempt(receipt, attempt);
      await validateStoredAcknowledgement(attempt, reviewed);
      if (dependencies.validateProof) {
        await dependencies.validateProof(
          attempt.proof,
          scope,
          attempt.scoutPubkey,
          attempt.acknowledgement.eventId,
          attempt.approvalRequestId,
        );
      } else {
        assertScoutSetupProof(
          attempt.proof,
          scope,
          attempt.scoutPubkey,
          attempt.acknowledgement.eventId,
          attempt.approvalRequestId,
        );
      }
      return clone(attempt.proof);
    });
  }

  return {
    scope,
    attemptStore: store,
    approve,
    reconcileSavedProof,
    readAttempt: () => store.read(scope),
  };
}

export type ChannelOnboardingRuntime = ReturnType<
  typeof createChannelOnboardingRuntime
>;
