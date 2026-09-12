# Scout Channel Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable, inline Scout onboarding view and serializable reducer that guides an owner through exactly three starting routes, confirms an editable understanding, and delegates the final setup write to an I/O callback.

**Architecture:** Keep all onboarding facts and transitions in a pure reducer under `desktop/src/features/onboarding/channelOnboarding/state.ts`. The React view is controlled by that state and dispatches explicit actions; it owns only the render loop and an opaque request id for the setup callback. `onApproveSetup` receives a route-scoped, owner-confirmed input and must return a durable setup proof before the reducer can enter `ready`. Relay, channel, owner identity, signed records, and persistence are supplied by the caller.

**Tech Stack:** React 19, TypeScript, Tailwind utility classes, existing `Button`, `Input`, `Textarea`, `Card`, `cn`, and `lucide-react`; Node’s focused test runner with the repo’s TypeScript test loader.

---

### Task 1: Define the serializable contract and reducer

**Files:**
- Create: `desktop/src/features/onboarding/channelOnboarding/types.ts`
- Create: `desktop/src/features/onboarding/channelOnboarding/state.ts`
- Test: `desktop/src/features/onboarding/channelOnboarding/state.test.mjs`

- [ ] **Step 1: Write focused reducer tests for the three routes and persistence.**

  Cover one meaningful path for each route, including optional blanks, route switching without answer leakage, and reload-safe round-tripping:

  ```js
  test("new route keeps a deliberately blank optional answer", () => {
    let state = createInitialScoutOnboardingState({
      signupContext: { ownerName: "Ari" },
    });
    state = scoutOnboardingReducer(state, { type: "select-route", route: "new" });
    state = scoutOnboardingReducer(state, {
      type: "set-new-answer",
      field: "description",
      value: "",
    });
    assert.equal(state.routes.new.description, "");
    assert.equal(deserializeScoutOnboardingState(serializeScoutOnboardingState(state)).routes.new.description, "");
  });

  test("switching routes preserves isolated drafts and invalidates confirmation", () => {
    let state = completeNewRoute();
    state = scoutOnboardingReducer(state, { type: "confirm-understanding" });
    assert.equal(state.understanding.status, "confirmed");
    state = scoutOnboardingReducer(state, { type: "select-route", route: "deciding" });
    assert.equal(state.routes.new.category, "local-services");
    assert.deepEqual(state.routes.deciding.skills, []);
    assert.equal(state.understanding.status, "draft");
  });

  test("failed setup can retry and stale completion is ignored", () => {
    let state = completeExistingRoute();
    state = scoutOnboardingReducer(state, { type: "confirm-understanding" });
    state = scoutOnboardingReducer(state, { type: "approve-setup-started", requestId: "r1" });
    state = scoutOnboardingReducer(state, { type: "approve-setup-failed", requestId: "r1", error: "Relay unavailable" });
    assert.equal(state.setup.phase, "error");
    state = scoutOnboardingReducer(state, { type: "approve-setup-started", requestId: "r2" });
    state = scoutOnboardingReducer(state, { type: "approve-setup-succeeded", requestId: "r1", proof: proof("r1") });
    assert.equal(state.setup.phase, "saving");
    state = scoutOnboardingReducer(state, { type: "approve-setup-succeeded", requestId: "r2", proof: proof("r2") });
    assert.equal(state.setup.phase, "ready");
  });
  ```

- [ ] **Step 2: Run only the new test before implementation and observe the expected missing-export failure.**

  Run `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/channelOnboarding/state.test.mjs`.

- [ ] **Step 3: Add typed route drafts, actions, setup proof, and serialization boundaries.**

  `types.ts` defines the exact public unions and callback payload. All persisted fields are JSON values: strings retain `""`, arrays contain only known skill ids, and setup request ids are opaque strings. `state.ts` exposes `createInitialScoutOnboardingState`, `scoutOnboardingReducer`, `serializeScoutOnboardingState`, `deserializeScoutOnboardingState`, `getScoutOnboardingSummary`, `getScoutSetupInput`, and `isScoutRouteComplete`.

- [ ] **Step 4: Implement immutable transitions and stale-result guards.**

  Route selection resets the visible stage and clears global confirmation/setup state while preserving each route draft. Editing any confirmed understanding field returns the state to the editable understanding and clears setup proof. `approve-setup-succeeded` and `approve-setup-failed` apply only when their request id equals the currently saving request id; stale completions return the prior state object.

- [ ] **Step 5: Run the focused tests and inspect the serialized fixture.**

  Run the command from Step 2. Expected: all route, blank-value, branch-switch, failure/retry, stale-completion, and round-trip tests pass.

### Task 2: Build the inline Scout channel view

**Files:**
- Create: `desktop/src/features/onboarding/channelOnboarding/ScoutChannelOnboarding.tsx`
- Create: `desktop/src/features/onboarding/channelOnboarding/index.ts`

- [ ] **Step 1: Add a controlled component API that keeps I/O outside the view.**

  The component accepts `state`, `dispatch`, `signupContext`, `onApproveSetup`, and `onContinueInWelcome`. `onApproveSetup` is called only from the explicit “Approve this workspace setup” button, with `getScoutSetupInput(state)` and the request id. A successful returned proof dispatches `approve-setup-succeeded`; a rejected promise dispatches `approve-setup-failed`. No effect starts setup, no timer changes state, and no visual navigation marks the workspace ready.

- [ ] **Step 2: Render the approved conversation fragment inline.**

  Render dated message/thread content, Scout and owner bubbles, and the current onboarding block. The parent already supplies the application shell, sidebar, channel header, and `#welcome` thread, so this component must not duplicate any of them. Keep the fragment self-contained so the parent can place it inside the existing Welcome message/thread. Use `aria-labelledby`, labels, `aria-current`, `aria-pressed`, `aria-live`, keyboard-operable buttons, and visible focus styles. Never include design-review controls, sample business data, fake timers, or ad-hoc HTML strings.

- [ ] **Step 3: Implement the exact route questions and progression.**

  Arrival offers only “Start a new business”, “Help with my existing business”, and “Help me decide what to start”. New asks for category, optional short description, optional owner note, idea stage (`idea`, `preparing`, `testing`), and a relevant priority. Existing confirms seeded business/site context, asks for a site only when absent or changed, permits “I don’t have one”, and asks the current priority. Decide allows multiple skills/experience/interests, then a direction including “Still exploring”, followed by a priority. Optional personal notes remain optional and no decide route asks for a site.

- [ ] **Step 4: Render editable understanding, minimal setup proposal, saving/error/ready states.**

  The understanding block exposes person, business/idea, priority, and route-specific unknowns; its “This looks right” control requires a complete route and explicit confirmation. The setup block describes Scout-only guidance in the existing Welcome context and future work in threads, with no extra hires or job. Saving shows callback-driven progress; error preserves the draft and offers retry; ready displays the proof-backed context and an orientation for continuing in `#welcome`.

- [ ] **Step 5: Apply current theme tokens and responsive behavior.**

  Use `bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, and `text-primary` tokens with rem-safe stock text classes. Keep the editorial spacing, quiet lavender accent, soft borders, and single-column small-screen layout from the approved reference while allowing the host app to provide the shell and height.

### Task 3: Export and verify the module boundary

**Files:**
- Modify: `desktop/src/features/onboarding/channelOnboarding/index.ts`

- [ ] **Step 1: Export only the reusable public surface.**

  Export the state types, reducer helpers, summary/setup selectors, and `ScoutChannelOnboarding`. Do not export internal option arrays or host-specific relay/storage details.

- [ ] **Step 2: Run focused state tests again and inspect the diff.**

  Run `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/channelOnboarding/state.test.mjs` and `git diff --check`. Do not run `just ci`, a desktop build, Rust compilation, app launch, or full test suites for this bounded module task.

- [ ] **Step 3: Report the exact API and proof boundary to the orchestrator.**

  Include the new file paths, focused test command/result, reducer request-id guard, and the fact that durable signed setup I/O remains the parent/architecture agent’s responsibility.

---

## Self-review checklist

- [ ] All three arrival choices are present and route drafts remain isolated.
- [ ] Signup owner/business/site context is seeded; existing route does not re-ask known facts.
- [ ] New route has category, short description, idea stage, and relevant priority.
- [ ] Existing route has confirmation, optional/changable website, explicit no-site path, and priority.
- [ ] Decide route has selectable skills/interests, “Still exploring”, and no site field.
- [ ] Optional personal notes and blank edits persist exactly.
- [ ] Understanding requires explicit confirmation before setup.
- [ ] Setup proposal is Scout-only, Welcome/context scoped, thread-oriented, and contains no extra hire/job.
- [ ] Setup readiness comes only from callback proof; errors retry and stale completions are ignored.
- [ ] State is serializable and has no owner/relay/channel/root or I/O singleton.
- [ ] UI has no render-triggered actions, fake timers, design controls, or copied sample data.
