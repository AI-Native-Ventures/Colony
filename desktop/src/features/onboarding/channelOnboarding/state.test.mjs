import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialScoutOnboardingState,
  deserializeScoutOnboardingState,
  getScoutOnboardingSummary,
  getScoutSetupInput,
  isScoutRouteComplete,
  scoutOnboardingReducer,
  serializeScoutOnboardingState,
} from "./state.ts";

const proof = (proofId) => ({ proofId, recordIds: [`record-${proofId}`] });

function send(state, ...actions) {
  return actions.reduce(scoutOnboardingReducer, state);
}

function newRouteState() {
  let state = createInitialScoutOnboardingState({
    signupContext: { ownerName: "Ari" },
  });
  state = send(
    state,
    { type: "select-route", route: "new" },
    { type: "set-new-answer", field: "category", value: "local-services" },
    { type: "set-new-answer", field: "description", value: "" },
    { type: "advance-new-intake" },
    { type: "set-new-answer", field: "idea", value: "A weekend service" },
    { type: "set-new-answer", field: "ideaStage", value: "testing" },
    { type: "advance-new-business" },
    { type: "set-new-answer", field: "goal", value: "" },
    { type: "set-new-answer", field: "priority", value: "demand" },
    { type: "advance-new-follow-up" },
  );
  return state;
}

function existingRouteState() {
  let state = createInitialScoutOnboardingState({
    signupContext: {
      ownerName: "Mina",
      businessName: "Pine & Thread",
      businessDescription: "A small homewares studio",
      website: "https://pine-thread.example",
    },
  });
  state = send(
    state,
    { type: "select-route", route: "existing" },
    { type: "confirm-existing" },
    { type: "advance-existing-business" },
    { type: "set-existing-answer", field: "goal", value: "" },
    { type: "set-existing-answer", field: "priority", value: "delivery" },
    { type: "advance-existing-follow-up" },
  );
  return state;
}

function decidingRouteState() {
  let state = createInitialScoutOnboardingState({
    signupContext: { ownerName: "Jo" },
  });
  state = send(
    state,
    { type: "select-route", route: "deciding" },
    { type: "toggle-deciding-skill", skill: "operations" },
    { type: "set-deciding-person", value: "" },
    { type: "advance-deciding-intake" },
    { type: "set-deciding-direction", value: "still-exploring" },
    { type: "advance-deciding-business" },
    { type: "set-deciding-priority", value: "clarify" },
    { type: "advance-deciding-follow-up" },
  );
  return state;
}

test("new route keeps deliberately blank optional answers and survives reload", () => {
  const state = newRouteState();
  assert.equal(state.stage, "understanding");
  assert.equal(state.routes.new.description, "");
  assert.equal(state.routes.new.goal, "");
  assert.equal(state.routes.new.edited.goal, true);
  assert.equal(isScoutRouteComplete(state), true);

  const restored = deserializeScoutOnboardingState(
    serializeScoutOnboardingState(state),
  );
  assert.deepEqual(restored.routes.new, state.routes.new);
  assert.equal(getScoutOnboardingSummary(restored)?.priority, "");
});

test("existing route seeds and confirms supplied business/site without reasking", () => {
  const state = existingRouteState();
  assert.equal(
    state.routes.existing.business,
    "Pine & Thread — A small homewares studio",
  );
  assert.equal(state.routes.existing.website, "https://pine-thread.example");
  assert.equal(state.routes.existing.websiteState, "provided");
  assert.equal(state.stage, "understanding");
  assert.equal(isScoutRouteComplete(state), true);
  assert.equal(
    getScoutOnboardingSummary(state)?.website,
    "https://pine-thread.example",
  );
  assert.equal(getScoutOnboardingSummary(state)?.websiteState, "provided");
});

test("explicit signup no-site choice stays answered through reload", () => {
  const state = createInitialScoutOnboardingState({
    signupContext: {
      ownerName: "Mina",
      businessName: "Pine & Thread",
      website: null,
      websiteState: "none",
    },
  });
  assert.equal(state.routes.existing.website, "");
  assert.equal(state.routes.existing.websiteState, "none");
  assert.equal(state.routes.existing.websiteEditing, false);

  const restored = deserializeScoutOnboardingState(
    serializeScoutOnboardingState(state),
  );
  assert.equal(restored.signupContext.websiteState, "none");
  assert.equal(restored.routes.existing.websiteState, "none");
  assert.equal(restored.routes.existing.websiteEditing, false);

  const completed = send(
    state,
    { type: "select-route", route: "existing" },
    { type: "confirm-existing" },
    { type: "advance-existing-business" },
    { type: "set-existing-answer", field: "priority", value: "delivery" },
    { type: "advance-existing-follow-up" },
  );
  assert.equal(getScoutOnboardingSummary(completed)?.websiteState, "none");
  const confirmed = scoutOnboardingReducer(completed, {
    type: "confirm-understanding",
  });
  assert.equal(getScoutSetupInput(confirmed)?.summary.websiteState, "none");
  const started = scoutOnboardingReducer(confirmed, {
    type: "approve-setup-started",
    requestId: "no-site-request",
  });
  const startedReload = deserializeScoutOnboardingState(
    serializeScoutOnboardingState(started),
  );
  assert.equal(startedReload.setup.input?.summary.websiteState, "none");
});

test("decide route allows multiple skills and a still-exploring direction without a site", () => {
  const state = decidingRouteState();
  assert.deepEqual(state.routes.deciding.skills, ["operations"]);
  assert.equal(state.routes.deciding.person, "");
  assert.equal(state.routes.deciding.direction, "still-exploring");
  assert.equal(getScoutOnboardingSummary(state)?.website, null);
  assert.equal(isScoutRouteComplete(state), true);
});

test("switching routes keeps isolated drafts and invalidates a confirmed readback", () => {
  let state = newRouteState();
  state = scoutOnboardingReducer(state, { type: "confirm-understanding" });
  assert.equal(state.understanding.status, "confirmed");
  state = scoutOnboardingReducer(state, {
    type: "select-route",
    route: "deciding",
  });
  assert.equal(state.routes.new.category, "local-services");
  assert.deepEqual(state.routes.deciding.skills, []);
  assert.equal(state.understanding.status, "draft");
  assert.equal(state.setup.phase, "idle");
});

test("editing a confirmed website preserves the current route progress but requires reconfirmation", () => {
  let state = existingRouteState();
  state = send(
    state,
    { type: "confirm-understanding" },
    { type: "set-understanding-answer", field: "website", value: "" },
  );
  assert.equal(state.stage, "understanding");
  assert.equal(state.understanding.status, "draft");
  assert.equal(state.routes.existing.website, "");
  assert.equal(state.routes.existing.websiteState, "unknown");
  assert.equal(isScoutRouteComplete(state), true);
});

test("setup errors are retryable and stale async completions cannot make the state ready", () => {
  let state = existingRouteState();
  state = scoutOnboardingReducer(state, { type: "confirm-understanding" });
  state = scoutOnboardingReducer(state, {
    type: "approve-setup-started",
    requestId: "request-1",
  });
  state = scoutOnboardingReducer(state, {
    type: "approve-setup-failed",
    requestId: "request-1",
    error: "Relay unavailable",
  });
  assert.equal(state.setup.phase, "error");
  state = scoutOnboardingReducer(state, {
    type: "approve-setup-started",
    requestId: "request-2",
  });
  state = scoutOnboardingReducer(state, {
    type: "approve-setup-succeeded",
    requestId: "request-1",
    proof: proof("request-1"),
  });
  assert.equal(state.setup.phase, "saving");
  state = scoutOnboardingReducer(state, {
    type: "approve-setup-succeeded",
    requestId: "request-2",
    proof: proof("request-2"),
  });
  assert.equal(state.setup.phase, "ready");
  assert.equal(state.stage, "ready");
  assert.equal(state.setup.proof.proofId, "request-2");
});

test("ready requires an actual proof and setup input carries exact edited blanks", () => {
  let state = newRouteState();
  state = send(
    state,
    { type: "confirm-understanding" },
    { type: "set-setup-draft", field: "name", value: "" },
  );
  const input = getScoutSetupInput(state);
  assert.equal(input?.setupName, "");
  assert.equal(input?.summary.location, null);
  assert.equal(input?.summary.unknowns.includes("Exact area"), true);
  state = scoutOnboardingReducer(state, {
    type: "approve-setup-started",
    requestId: "request-blank-proof",
  });
  state = scoutOnboardingReducer(state, {
    type: "approve-setup-succeeded",
    requestId: "request-blank-proof",
    proof: { proofId: "" },
  });
  assert.equal(state.setup.phase, "error");
  assert.equal(state.stage, "setting-up");
});

test("known new-business location is carried into the summary and removes that unknown", () => {
  let state = newRouteState();
  state = scoutOnboardingReducer(state, {
    type: "set-understanding-answer",
    field: "location",
    value: "Cape Town",
  });
  const summary = getScoutOnboardingSummary(state);
  assert.equal(summary?.location, "Cape Town");
  assert.equal(summary?.unknowns.includes("Exact area"), false);
});

test("an interrupted saving state reloads as a retryable error", () => {
  let state = existingRouteState();
  state = send(
    state,
    { type: "confirm-understanding" },
    { type: "approve-setup-started", requestId: "request-in-flight" },
  );
  const restored = deserializeScoutOnboardingState(
    serializeScoutOnboardingState(state),
  );
  assert.equal(restored.setup.phase, "error");
  assert.equal(restored.setup.error, "Setup was interrupted. Try again.");
  assert.equal(restored.stage, "setting-up");
  assert.equal(restored.setup.requestId, "request-in-flight");
  assert.equal(restored.setup.input?.route, "existing");
  assert.equal(restored.setup.input?.summary.websiteState, "provided");
});

test("an invalid persisted ready proof cannot claim readiness", () => {
  const state = scoutOnboardingReducer(existingRouteState(), {
    type: "confirm-understanding",
  });
  const malformed = serializeScoutOnboardingState({
    ...state,
    stage: "ready",
    setup: {
      ...state.setup,
      phase: "ready",
      requestId: null,
      proof: { proofId: "   " },
    },
  });
  const restored = deserializeScoutOnboardingState(malformed);
  assert.notEqual(restored.setup.phase, "ready");
  assert.equal(restored.setup.proof, null);
  assert.equal(restored.stage, "setup");
});
