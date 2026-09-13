import type {
  CreateInitialScoutOnboardingStateOptions,
  DecidingRouteState,
  ExistingRouteState,
  NewRouteState,
  ScoutOnboardingState,
  ScoutSetupDraft,
} from "./types";
import {
  SCOUT_ONBOARDING_STATE_VERSION,
  businessSeed,
  emptyProgress,
  normalizeContext,
  ownerSeed,
} from "./constants";

function emptyNewRoute(person: string): NewRouteState {
  return {
    person,
    category: "",
    description: "",
    idea: "",
    ideaStage: "",
    goal: "",
    priority: "",
    location: "",
    edited: {},
    progress: emptyProgress(),
  };
}

function emptyExistingRoute(
  context: ReturnType<typeof normalizeContext>,
): ExistingRouteState {
  const business = businessSeed(context);
  const website = context.website;
  const websiteState = context.websiteState;
  return {
    person: ownerSeed(context),
    business,
    businessEditing: business.length === 0,
    website,
    websiteState,
    websiteEditing: websiteState === "unknown",
    goal: "",
    priority: "",
    edited: {},
    confirmed: false,
    progress: emptyProgress(),
  };
}

function emptyDecidingRoute(person: string): DecidingRouteState {
  return {
    person,
    skills: [],
    direction: "",
    priority: "",
    edited: {},
    progress: emptyProgress(),
  };
}

export function emptySetupDraft(): ScoutSetupDraft {
  return {
    name: "",
    description: "",
    nameEdited: false,
    descriptionEdited: false,
  };
}

/** Create the first state without reading localStorage, the relay, or Tauri. */
export function createInitialScoutOnboardingState(
  options: CreateInitialScoutOnboardingStateOptions = {},
): ScoutOnboardingState {
  const signupContext = normalizeContext(options.signupContext);
  const person = ownerSeed(signupContext);
  return {
    version: SCOUT_ONBOARDING_STATE_VERSION,
    stage: "arrival",
    route: null,
    signupContext,
    routes: {
      new: emptyNewRoute(person),
      existing: emptyExistingRoute(signupContext),
      deciding: emptyDecidingRoute(person),
    },
    understanding: { status: "draft" },
    setupDrafts: {
      new: emptySetupDraft(),
      existing: emptySetupDraft(),
      deciding: emptySetupDraft(),
    },
    setup: {
      phase: "idle",
      requestId: null,
      input: null,
      error: null,
      proof: null,
    },
    notice: null,
  };
}
