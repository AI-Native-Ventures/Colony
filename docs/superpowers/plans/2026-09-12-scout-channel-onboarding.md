# Scout Channel Onboarding Implementation Record

**Status:** The pure state, inline view, signed-root mount, and host integration are implemented in the onboarding worktree. Runtime and storage provide the real signed setup boundary. GitHub browser/native checks are still pending in PR766.

## Outcome

Scout opens as an inline fragment inside the existing Welcome message and thread. The first question has exactly three choices: start a new business, help with an existing business, or decide what to start. Each route keeps its own answers, preserves intentional blanks, reuses known signup context, and ends at an editable understanding. Setup is shown only after explicit owner confirmation and becomes ready only from a proof returned by the runtime.

The pure state does not know the owner, relay, channel, root event, storage, or runtime. The host supplies that scope and seeds `ScoutSignupContext` from the signed root payload (or accepts an explicit context override). An explicit `websiteState: "none"` survives serialization so the existing route does not ask for a website again.

## Public API

The stable state barrel is `desktop/src/features/onboarding/channelOnboarding/index.ts`, which exports the types, initializer, reducer, selectors, and serialization helpers. The main contracts are:

- `createInitialScoutOnboardingState({ signupContext? })` creates an arrival state without I/O.
- `scoutOnboardingReducer(state, action)` applies typed owner actions immutably. `ScoutOnboardingDispatch` is the `onChange` callback consumed by the view.
- `serializeScoutOnboardingState` and `deserializeScoutOnboardingState` round-trip JSON-safe drafts, including exact edited blanks.
- `getScoutOnboardingSummary(state)` returns the complete route summary, including priority, unknowns, location, website, and `websiteState`.
- `getScoutSetupInput(state)` returns a frozen, owner-confirmed setup snapshot or `null`.
- `ScoutChannelOnboarding` accepts `state`, `onChange`, optional `onConfirm`, `onApproveSetup(input, requestId)`, optional `onRetry` with the same snapshot contract, and `onContinueInWelcome`.

`ScoutOnboardingHost` adds the scoped runtime boundary. Its `scope` contains owner pubkey, relay URL, channel id, thread root id, and signup request id. It accepts optional `rootPayload`, `signupContext`, `initialState`, runtime dependencies, or a supplied runtime. It creates the default runtime, persists the draft, synchronizes same-window and cross-window mounts, blocks actions when storage/runtime access fails, and remounts when the full scope changes.

The host reuses a durable `approvalRequestId` only when the saved setup input is an exact snapshot match. A changed snapshot receives a new UUID. A retry keeps the same request identity and signed records so an uncertain write cannot be duplicated.

`ScoutOnboardingMessage` verifies the current owner, active relay, Welcome channel, root kind, thread shape, payload, and signature. It accepts an exact `rootEvent` adapter value or fetches `getEventById(message.id)` using a relay-and-event query key. `MessageRow` mounts it for the verified root in both the timeline and thread; ordinary message Markdown remains the fallback while the signed root is loading. When no explicit continuation callback is supplied, its verified channel scope drives the existing `goChannel(channelId, { replace: true })` navigation, which returns to Welcome and closes the thread query.

## Implemented modules

Pure state is split by responsibility:

- `channelOnboarding/types.ts`, `constants.ts`, `initialState.ts`, `reducer.ts`, `selectors.ts`, and `serialization.ts`.
- `channelOnboarding/state.ts` and `channelOnboarding/index.ts` are stable barrels.

The route view is split into `ScoutChannelOnboarding.tsx`, `ArrivalStage.tsx`, `NewRouteStages.tsx`, `ExistingRouteStages.tsx`, `DecidingRouteStages.tsx`, `UnderstandingStage.tsx`, `SetupStages.tsx`, and `shared.tsx`.

The integration boundary is `channelOnboardingHost.tsx` and `ui/ScoutOnboardingMessage.tsx`. Signed setup I/O is implemented behind `channelOnboardingSetup.ts`, `channelOnboardingStorage.ts`, `channelOnboardingRuntime.ts`, and the runtime `attempt`, `acknowledgement`, and `reply` modules. The runtime exposes `reconcileSavedProof(input)` for read-only ready-state recovery after reload.

## Completed checkpoints

- [x] All three routes, optional personal notes, exact blanks, seeded owner/business/site facts, explicit no-site state, and route-isolated drafts.
- [x] New-route category validation, including required words for `other`; idea stage and relevant priority.
- [x] Existing-route business confirmation, supplied-site reuse, changed-site editing, and no-site choice.
- [x] Decide-route multi-select skills, direction including “Still exploring,” priority, and no site field.
- [x] Editable understanding, explicit confirmation, minimal Scout-only Welcome/thread setup proposal, and proof-gated ready state.
- [x] Immutable reducer transitions, changed-answer invalidation, stale async completion rejection, interrupted-saving retry state, and invalid-ready-proof rejection.
- [x] Scoped host lifecycle, storage-error blocking, same-window/cross-window draft synchronization, signed-root owner guard, and dual timeline/thread mount assertion.
- [x] Cached ready state automatically enters “Checking saved setup” and calls read-only `runtime.reconcileSavedProof`; successful verification restores ready without an approval or manual retry.

## Verification boundary

The following focused checks were run in the onboarding worktree:

```text
node --import ./test-loader.mjs --experimental-strip-types --test \
  src/features/onboarding/channelOnboarding/state.test.mjs \
  src/features/onboarding/channelOnboardingHost.test.mjs
15 passed, 0 failed

node desktop/scripts/check-file-sizes.mjs
passed

git diff --check
passed
```

A scoped strict TypeScript program covering Host, ScoutOnboardingMessage, MessageRow, setup, runtime, and runtime submodules reported `relevantDiagnostics=0`. It also surfaced 30 existing diagnostics outside this graph (CSS/Vite asset and declaration issues); no full project typecheck was run. Targeted Biome checks passed, with one pre-existing non-null assertion warning in the E2E fixture spec.

Local CI, desktop builds, Rust compilation, app launch, and browser/native E2E were intentionally not run. PR766’s GitHub checks are the remaining browser/native proof boundary.
