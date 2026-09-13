import * as React from "react";

import type { RelayEvent } from "@/shared/api/types";
import type { ScoutOnboardingRootPayload } from "./channelOnboardingRuntime/protocol";
import {
  createInitialScoutOnboardingState,
  deserializeScoutOnboardingState,
  scoutOnboardingReducer,
  serializeScoutOnboardingState,
  type ScoutApproveSetup,
  type ScoutOnboardingAction,
  type ScoutOnboardingDispatch,
  type ScoutOnboardingState,
  type ScoutOnboardingSummary,
  type ScoutSetupInput,
  type ScoutSetupProof,
  type ScoutSignupContext,
} from "./channelOnboarding/state";
import { ScoutChannelOnboarding } from "./channelOnboarding/ScoutChannelOnboarding";
import { sameScoutSetupInput } from "./channelOnboardingSetup";
import {
  createChannelOnboardingBrowserStore,
  channelOnboardingStorageKey,
  snapshotChannelOnboardingScope,
  SCOUT_ONBOARDING_DRAFT_SLOT,
  type ChannelOnboardingScope,
} from "./channelOnboardingStorage";
import {
  createChannelOnboardingRuntime,
  type ChannelOnboardingRuntime,
  type ChannelOnboardingRuntimeDependencies,
} from "./channelOnboardingRuntime";

export type ScoutOnboardingHostProps = {
  scope: ChannelOnboardingScope;
  /** The signed root is kept available for host-side diagnostics and future protocol adapters. */
  rootEvent?: RelayEvent;
  /** Parsed protocol seed from the owner-signed root. */
  rootPayload?: ScoutOnboardingRootPayload;
  signupContext?: ScoutSignupContext;
  initialState?: ScoutOnboardingState;
  runtime?: ChannelOnboardingRuntime;
  runtimeDependencies?: ChannelOnboardingRuntimeDependencies;
  onContinueInWelcome?: () => void;
  onConfirm?: (summary: ScoutOnboardingSummary) => void;
  className?: string;
};

function seedContext(payload?: ScoutOnboardingRootPayload): ScoutSignupContext {
  if (!payload) return {};
  return {
    ownerName: payload.seed.ownerName,
    ownerNote: payload.seed.ownerNote,
    businessName: payload.seed.businessName,
    businessDescription: payload.seed.businessDescription,
    website: payload.seed.website,
    websiteState: payload.seed.websiteState,
  };
}

const SCOUT_STAGES = new Set([
  "arrival",
  "person",
  "business",
  "follow-up",
  "understanding",
  "setup",
  "setting-up",
  "ready",
]);
const SCOUT_ROUTES = new Set(["new", "existing", "deciding"]);
const SCOUT_WEBSITE_STATES = new Set(["unknown", "provided", "none"]);
const CHECKING_SAVED_SETUP_NOTICE = "Checking saved setup…";
const SAVED_SETUP_RECONCILE_ERROR =
  "The saved setup could not be checked yet. Retry setup to continue.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadyScoutOnboardingState(
  value: unknown,
): value is ScoutOnboardingState {
  return (
    isScoutOnboardingStateEnvelope(value) &&
    value.stage === "ready" &&
    value.setup.phase === "ready"
  );
}

/**
 * Storage validation must reject a corrupt envelope before deserialization.
 * Deserialization intentionally repairs ordinary draft edits, so using it as
 * the validator would turn an invalid value into a fresh state and hide the
 * fact that storage was not trustworthy.
 */
export function isScoutOnboardingStateEnvelope(
  value: unknown,
): value is ScoutOnboardingState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.setup)) {
    return false;
  }
  const signupContext = isRecord(value.signupContext)
    ? value.signupContext
    : null;
  const routes = isRecord(value.routes) ? value.routes : null;
  const understanding = isRecord(value.understanding)
    ? value.understanding
    : null;
  const setupDrafts = isRecord(value.setupDrafts) ? value.setupDrafts : null;
  const setup = value.setup;
  const proof = setup.proof;
  if (
    !(typeof value.stage === "string" && SCOUT_STAGES.has(value.stage)) ||
    !(
      value.route === null ||
      (typeof value.route === "string" && SCOUT_ROUTES.has(value.route))
    ) ||
    !signupContext ||
    ![
      "ownerName",
      "ownerNote",
      "businessName",
      "businessDescription",
      "website",
    ].every((key) => typeof signupContext[key] === "string") ||
    typeof signupContext.websiteState !== "string" ||
    !SCOUT_WEBSITE_STATES.has(signupContext.websiteState) ||
    !routes ||
    !["new", "existing", "deciding"].every((key) => isRecord(routes[key])) ||
    !understanding ||
    (understanding.status !== "draft" &&
      understanding.status !== "confirmed") ||
    !setupDrafts ||
    !["new", "existing", "deciding"].every((key) =>
      isRecord(setupDrafts[key]),
    ) ||
    !["idle", "saving", "error", "ready"].includes(setup.phase as string) ||
    !(setup.requestId === null || typeof setup.requestId === "string") ||
    !(setup.input === null || isRecord(setup.input)) ||
    !(setup.error === null || typeof setup.error === "string") ||
    !(
      proof === null ||
      (isRecord(proof) &&
        typeof proof.proofId === "string" &&
        proof.proofId.trim().length > 0)
    ) ||
    (setup.phase === "ready" &&
      (!isRecord(proof) ||
        typeof proof.proofId !== "string" ||
        proof.proofId.trim().length === 0)) ||
    (setup.phase !== "ready" && proof !== null) ||
    (value.stage === "ready" && setup.phase !== "ready") ||
    !(value.notice === null || typeof value.notice === "string")
  ) {
    return false;
  }
  return true;
}

export function hydrateScoutOnboardingState(
  value: ScoutOnboardingState,
  context: ScoutSignupContext,
): ScoutOnboardingState {
  const hydrated = deserializeScoutOnboardingState(
    serializeScoutOnboardingState(value),
    { signupContext: context },
  );
  if (!isScoutOnboardingStateEnvelope(hydrated)) {
    throw new Error("Scout could not normalize its saved draft safely.");
  }
  // A proof in UI storage is display state only. The runtime must revalidate
  // the signed action, receipt, acknowledgment, and reply after reload.
  if (hydrated.setup.phase === "ready" || hydrated.stage === "ready") {
    return {
      ...hydrated,
      stage: "setting-up",
      setup: {
        ...hydrated.setup,
        phase: "error",
        requestId: null,
        error:
          "Setup needs a quick check after reload. Retry to confirm Scout is ready.",
        proof: null,
      },
      notice:
        "Setup needs a quick check after reload. Retry to confirm Scout is ready.",
    };
  }
  return hydrated;
}

/**
 * Normalize a state received from another mounted Welcome surface without
 * treating its active save as an interrupted reload. A persisted save is
 * still converted to an error by the ordinary reload path above; live
 * adoption keeps the request in flight so its eventual proof can advance
 * every mounted surface together.
 */
export function hydrateScoutOnboardingStateForLiveUpdate(
  value: ScoutOnboardingState,
  context: ScoutSignupContext,
): ScoutOnboardingState {
  const hydrated = deserializeScoutOnboardingState(
    serializeScoutOnboardingState(value),
    { signupContext: context },
  );
  if (!isScoutOnboardingStateEnvelope(hydrated)) {
    throw new Error("Scout could not normalize its live draft safely.");
  }
  if (value.setup.phase !== "saving") return hydrated;

  return {
    ...hydrated,
    stage: "setting-up",
    setup: {
      ...hydrated.setup,
      phase: "saving",
      error: null,
      proof: null,
    },
    notice: null,
  };
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function withNotice(
  state: ScoutOnboardingState,
  notice: string,
): ScoutOnboardingState {
  return { ...state, notice };
}

function scopeKey(scope: ChannelOnboardingScope) {
  return [
    scope.ownerPubkey,
    scope.relayUrl,
    scope.channelId,
    scope.threadRootId,
    scope.requestId,
  ].join("\u001f");
}

export function scoutOnboardingScopeKey(scope: ChannelOnboardingScope) {
  return scopeKey(scope);
}

export function shouldAdoptScoutOnboardingStorageState(input: {
  currentSerialized: string;
  incomingSerialized: string | null;
  lastPersistedSerialized: string | null;
}) {
  return Boolean(
    input.incomingSerialized &&
      input.incomingSerialized !== input.currentSerialized &&
      input.incomingSerialized !== input.lastPersistedSerialized,
  );
}

function createFallbackUuid() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    const seed = Date.now();
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (seed + index * 47) & 0xff;
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function newScoutSetupRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? createFallbackUuid();
}

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

type ScoutRuntimeWithReconciliation = ChannelOnboardingRuntime & {
  reconcileSavedProof?: (
    input: ScoutSetupInput,
  ) => Promise<ScoutSetupProof | null>;
};

export function requestIdForScoutSetup(
  runtime: ChannelOnboardingRuntime,
  candidate: string,
  input: ScoutSetupInput,
) {
  const durable = runtime.readAttempt();
  if (durable && sameScoutSetupInput(durable.input, input)) {
    return durable.approvalRequestId;
  }
  // The view's request id is opaque. Native company actions require a UUID;
  // keep a supplied UUID stable and replace only legacy/test labels. A
  // completed attempt for a different snapshot must never donate its id.
  if (UUID.test(candidate)) {
    return candidate;
  }
  return newScoutSetupRequestId();
}

/**
 * Stateful host for the inline onboarding fragment.
 *
 * It owns the reducer and its durable draft while the runtime owns signed
 * records and their retry protocol. The view itself receives only controlled
 * state and dispatch callbacks; mounting this host does not start setup.
 */
function ScoutOnboardingHostInstance({
  scope: inputScope,
  rootEvent: _rootEvent,
  rootPayload,
  signupContext,
  initialState,
  runtime: suppliedRuntime,
  runtimeDependencies,
  onContinueInWelcome,
  onConfirm,
  className,
}: ScoutOnboardingHostProps) {
  const scope = React.useMemo(
    () =>
      snapshotChannelOnboardingScope({
        ownerPubkey: inputScope.ownerPubkey,
        relayUrl: inputScope.relayUrl,
        channelId: inputScope.channelId,
        threadRootId: inputScope.threadRootId,
        requestId: inputScope.requestId,
      }),
    [
      inputScope.ownerPubkey,
      inputScope.relayUrl,
      inputScope.channelId,
      inputScope.threadRootId,
      inputScope.requestId,
    ],
  );
  const context = React.useMemo(
    () => signupContext ?? seedContext(rootPayload),
    [rootPayload, signupContext],
  );
  type DraftStore = {
    read(scope: ChannelOnboardingScope): ScoutOnboardingState | null;
    write(scope: ChannelOnboardingScope, value: ScoutOnboardingState): void;
  };
  type DraftLoad = {
    state: ScoutOnboardingState;
    store: DraftStore | null;
    error: string | null;
    reconcileReady: boolean;
  };
  const [draftLoad] = React.useState<DraftLoad>(() => {
    try {
      const store = createChannelOnboardingBrowserStore(
        SCOUT_ONBOARDING_DRAFT_SLOT,
        isScoutOnboardingStateEnvelope,
      ) as DraftStore;
      const persisted = store.read(scope);
      const source = initialState ?? persisted;
      const draft = initialState
        ? hydrateScoutOnboardingState(initialState, context)
        : persisted
          ? hydrateScoutOnboardingState(persisted, context)
          : createInitialScoutOnboardingState({ signupContext: context });
      return {
        state: draft,
        store,
        error: null,
        reconcileReady: isReadyScoutOnboardingState(source),
      };
    } catch (error) {
      const message = errorText(
        error,
        "Scout could not open its saved draft. No new setup request will be sent.",
      );
      return {
        state: withNotice(
          createInitialScoutOnboardingState({ signupContext: context }),
          message,
        ),
        store: null,
        error: message,
        reconcileReady: false,
      };
    }
  });
  const draftStoreRef = React.useRef<DraftStore | null>(draftLoad.store);
  const draftStorageKey = React.useMemo(
    () => channelOnboardingStorageKey(scope, SCOUT_ONBOARDING_DRAFT_SLOT),
    [scope],
  );
  const [storageError, setStorageError] = React.useState<string | null>(
    draftLoad.error,
  );
  const [state, setState] = React.useState(draftLoad.state);
  const [readyReconciliationPending, setReadyReconciliationPending] =
    React.useState(draftLoad.reconcileReady);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const lastPersistedSerializedRef = React.useRef<string | null>(null);
  const reconciliationPromiseRef = React.useRef<Promise<unknown> | null>(null);
  const runtimeState = React.useState<{
    runtime: ChannelOnboardingRuntime | null;
    error: string | null;
  }>(() => {
    if (suppliedRuntime) return { runtime: suppliedRuntime, error: null };
    try {
      return {
        runtime: createChannelOnboardingRuntime(scope, runtimeDependencies),
        error: null,
      };
    } catch (error) {
      return {
        runtime: null,
        error: errorText(
          error,
          "Scout setup is unavailable in this window. No setup request was sent.",
        ),
      };
    }
  })[0];
  const runtime = runtimeState.runtime;
  const blockedReason = storageError ?? runtimeState.error;

  const adoptStoredDraft = React.useCallback(() => {
    const store = draftStoreRef.current;
    if (!store || storageError) return;
    try {
      const stored = store.read(scope);
      if (!stored) {
        if (lastPersistedSerializedRef.current !== null) {
          throw new Error(
            "Colony could not find the saved Scout draft. No setup request will be sent.",
          );
        }
        return;
      }
      const incomingSerialized = serializeScoutOnboardingState(stored);
      const currentSerialized = serializeScoutOnboardingState(stateRef.current);
      if (
        shouldAdoptScoutOnboardingStorageState({
          currentSerialized,
          incomingSerialized,
          lastPersistedSerialized: lastPersistedSerializedRef.current,
        })
      ) {
        lastPersistedSerializedRef.current = incomingSerialized;
        const incomingState = hydrateScoutOnboardingStateForLiveUpdate(
          stored,
          context,
        );
        setState(incomingState);
        setReadyReconciliationPending(isReadyScoutOnboardingState(stored));
      }
    } catch (error) {
      setStorageError(
        errorText(
          error,
          "Scout could not read its saved draft. No setup request will be sent.",
        ),
      );
    }
  }, [context, scope, storageError]);

  React.useEffect(() => {
    const store = draftStoreRef.current;
    if (!store || storageError) return;
    const onDraftChange = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: unknown }>).detail;
      if (detail?.key === undefined || detail.key === draftStorageKey) {
        adoptStoredDraft();
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === draftStorageKey) {
        adoptStoredDraft();
      }
    };
    globalThis.addEventListener?.(
      "colony-scout-channel-onboarding-changed",
      onDraftChange,
    );
    globalThis.addEventListener?.("storage", onStorage);
    return () => {
      globalThis.removeEventListener?.(
        "colony-scout-channel-onboarding-changed",
        onDraftChange,
      );
      globalThis.removeEventListener?.("storage", onStorage);
    };
  }, [adoptStoredDraft, draftStorageKey, storageError]);

  React.useEffect(() => {
    if (!draftStoreRef.current || storageError) return;
    try {
      const nextSerialized = serializeScoutOnboardingState(state);
      const stored = draftStoreRef.current.read(scope);
      const storedSerialized = stored
        ? serializeScoutOnboardingState(stored)
        : null;
      const lastPersistedSerialized = lastPersistedSerializedRef.current;
      if (
        stored &&
        storedSerialized !== null &&
        storedSerialized !== nextSerialized &&
        storedSerialized !== lastPersistedSerialized
      ) {
        // Another mounted Welcome surface won the write. Adopt the current
        // storage value instead of allowing a stale effect to overwrite it.
        lastPersistedSerializedRef.current = storedSerialized;
        setState(hydrateScoutOnboardingStateForLiveUpdate(stored, context));
        setReadyReconciliationPending(isReadyScoutOnboardingState(stored));
        return;
      }
      if (storedSerialized !== nextSerialized) {
        draftStoreRef.current.write(scope, state);
      }
      lastPersistedSerializedRef.current = nextSerialized;
    } catch (error) {
      setStorageError(
        errorText(
          error,
          "Scout could not save this draft. The existing signed request remains unchanged.",
        ),
      );
    }
  }, [context, scope, state, storageError]);

  React.useEffect(() => {
    if (!readyReconciliationPending || blockedReason || !runtime) return;
    if (reconciliationPromiseRef.current) return;

    const reconciler = (runtime as ScoutRuntimeWithReconciliation)
      .reconcileSavedProof;
    let attempt: ReturnType<ChannelOnboardingRuntime["readAttempt"]> = null;
    try {
      attempt = runtime.readAttempt();
    } catch (error) {
      setReadyReconciliationPending(false);
      setState((current) => ({
        ...current,
        stage: "setting-up",
        notice: null,
        setup: {
          ...current.setup,
          phase: "error",
          error: errorText(error, SAVED_SETUP_RECONCILE_ERROR),
          proof: null,
        },
      }));
      return;
    }

    const input = attempt?.input ?? stateRef.current.setup.input;
    const approvalRequestId =
      attempt?.approvalRequestId ?? stateRef.current.setup.requestId;
    const fail = (error: unknown) => {
      setReadyReconciliationPending(false);
      setState((current) => ({
        ...current,
        stage: "setting-up",
        notice: null,
        setup: {
          ...current.setup,
          phase: "error",
          requestId: approvalRequestId ?? current.setup.requestId,
          input: input ?? current.setup.input,
          error: errorText(error, SAVED_SETUP_RECONCILE_ERROR),
          proof: null,
        },
      }));
    };

    if (!reconciler || !input || !approvalRequestId) {
      fail(new Error(SAVED_SETUP_RECONCILE_ERROR));
      return;
    }

    let promise: Promise<ScoutSetupProof | null>;
    try {
      promise = Promise.resolve(reconciler(input));
    } catch (error) {
      fail(error);
      return;
    }
    reconciliationPromiseRef.current = promise;
    void promise
      .then((proof) => {
        if (reconciliationPromiseRef.current !== promise) return;
        reconciliationPromiseRef.current = null;
        if (
          !proof ||
          typeof proof.proofId !== "string" ||
          !proof.proofId.trim()
        ) {
          fail(new Error(SAVED_SETUP_RECONCILE_ERROR));
          return;
        }
        const current = stateRef.current;
        if (
          !current.setup.input ||
          !sameScoutSetupInput(current.setup.input, input)
        ) {
          fail(
            new Error(
              "The saved setup changed while it was being checked. Review it and try again.",
            ),
          );
          return;
        }
        setReadyReconciliationPending(false);
        setState({
          ...current,
          stage: "ready",
          notice: null,
          setup: {
            ...current.setup,
            phase: "ready",
            requestId: null,
            input,
            error: null,
            proof,
          },
        });
      })
      .catch((error) => {
        if (reconciliationPromiseRef.current === promise) {
          reconciliationPromiseRef.current = null;
        }
        fail(error);
      });
  }, [blockedReason, readyReconciliationPending, runtime]);

  const onChange = React.useCallback<ScoutOnboardingDispatch>(
    (action: ScoutOnboardingAction) => {
      if (blockedReason || readyReconciliationPending) return;
      setState((current) => scoutOnboardingReducer(current, action));
    },
    [blockedReason, readyReconciliationPending],
  );

  const approve = React.useCallback<ScoutApproveSetup>(
    async (input, requestId) => {
      if (blockedReason) {
        throw new Error(blockedReason);
      }
      if (readyReconciliationPending) {
        throw new Error("The saved setup is still being checked.");
      }
      if (!runtime) {
        throw new Error("Scout setup is unavailable in this window.");
      }
      const durableRequestId = requestIdForScoutSetup(
        runtime,
        requestId,
        input,
      );
      return runtime.approve(input, durableRequestId);
    },
    [blockedReason, readyReconciliationPending, runtime],
  );

  const confirm = React.useCallback(
    (summary: ScoutOnboardingSummary) => onConfirm?.(summary),
    [onConfirm],
  );

  const renderedState = blockedReason
    ? withNotice(state, blockedReason)
    : readyReconciliationPending
      ? {
          ...state,
          stage: "setting-up" as const,
          notice: null,
          setup: {
            ...state.setup,
            phase: "saving" as const,
            error: CHECKING_SAVED_SETUP_NOTICE,
            proof: null,
          },
        }
      : state;
  return (
    <ScoutChannelOnboarding
      className={className}
      onApproveSetup={approve}
      onChange={onChange}
      onConfirm={confirm}
      onContinueInWelcome={onContinueInWelcome}
      state={renderedState}
    />
  );
}

/** Remount the complete host when the account, relay, channel, or root changes. */
export function ScoutOnboardingHost(props: ScoutOnboardingHostProps) {
  return (
    <ScoutOnboardingHostInstance
      key={scoutOnboardingScopeKey(props.scope)}
      {...props}
    />
  );
}

export type { ChannelOnboardingScope } from "./channelOnboardingStorage";
