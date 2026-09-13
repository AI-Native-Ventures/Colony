import type {
  NewRouteState,
  ScoutOnboardingState,
  ScoutOnboardingSummary,
  ScoutRoute,
  ScoutSetupDraft,
  ScoutSetupInput,
} from "./types";
import {
  CATEGORY_LABELS,
  DIRECTION_LABELS,
  ONBOARDING_STAGES,
  PRIORITY_LABELS,
  STAGE_LABELS,
  nonBlank,
} from "./constants";

function currentRouteState(state: ScoutOnboardingState) {
  if (state.route === "new") return state.routes.new;
  if (state.route === "existing") return state.routes.existing;
  if (state.route === "deciding") return state.routes.deciding;
  return null;
}

function currentBusinessOrIdea(state: ScoutOnboardingState) {
  if (state.route === "new") {
    const route = state.routes.new;
    if (route.edited.idea) return route.idea;
    return nonBlank(
      route.idea,
      route.description,
      route.category ? CATEGORY_LABELS[route.category] : "",
    );
  }
  if (state.route === "existing") return state.routes.existing.business;
  if (state.route === "deciding") {
    const route = state.routes.deciding;
    if (route.edited.direction) return route.direction;
    return (
      DIRECTION_LABELS[route.direction as keyof typeof DIRECTION_LABELS] ??
      route.direction
    );
  }
  return "";
}

function currentPriority(state: ScoutOnboardingState) {
  const route = currentRouteState(state);
  if (!route || !("goal" in route)) {
    return state.route === "deciding"
      ? (PRIORITY_LABELS[state.routes.deciding.priority] ?? "")
      : "";
  }
  if (route.edited.priority || route.edited.goal) return route.goal;
  return nonBlank(route.goal, PRIORITY_LABELS[route.priority] ?? "");
}

function currentPriorityId(state: ScoutOnboardingState) {
  const route = currentRouteState(state);
  return route && "priority" in route ? route.priority : "";
}

function routeIsComplete(state: ScoutOnboardingState, route: ScoutRoute) {
  if (route === "new") {
    const current = state.routes.new;
    return Boolean(
      current.progress.intakeCompleted &&
        current.progress.middleCompleted &&
        current.progress.priorityCompleted &&
        current.category &&
        (current.category !== "other" || current.description.trim()) &&
        current.ideaStage &&
        current.priority,
    );
  }
  if (route === "existing") {
    const current = state.routes.existing;
    return Boolean(
      current.confirmed &&
        current.progress.middleCompleted &&
        current.progress.priorityCompleted &&
        current.business.trim() &&
        current.priority,
    );
  }
  const current = state.routes.deciding;
  return Boolean(
    current.progress.intakeCompleted &&
      current.progress.middleCompleted &&
      current.progress.priorityCompleted &&
      current.skills.length > 0 &&
      current.direction.trim() &&
      current.priority,
  );
}

/** Whether the selected route has every required owner choice. */
export function isScoutRouteComplete(state: ScoutOnboardingState) {
  return state.route !== null && routeIsComplete(state, state.route);
}

function unknownsFor(state: ScoutOnboardingState) {
  if (state.route === "new") {
    return [
      ...(state.routes.new.location.trim() ? [] : ["Exact area"]),
      "Pricing and proof of demand",
    ];
  }
  if (state.route === "existing") {
    return ["What source or access Scout may use", "The next concrete change"];
  }
  return [
    "Which offer and audience to choose",
    "What a small first test looks like",
  ];
}

/** Read the route answers as an owner-reviewable summary. */
export function getScoutOnboardingSummary(
  state: ScoutOnboardingState,
): ScoutOnboardingSummary | null {
  if (!state.route || !routeIsComplete(state, state.route)) return null;
  const route = currentRouteState(state);
  if (!route) return null;
  const website =
    state.route === "existing" &&
    state.routes.existing.websiteState === "provided"
      ? state.routes.existing.website
      : null;
  const summary: ScoutOnboardingSummary = {
    route: state.route,
    person: route.person,
    businessOrIdea: currentBusinessOrIdea(state),
    priority: currentPriority(state),
    priorityId: currentPriorityId(state),
    unknowns: unknownsFor(state),
    website,
    websiteState:
      state.route === "existing"
        ? state.routes.existing.websiteState
        : "unknown",
    location: state.route === "new" ? state.routes.new.location || null : null,
  };
  if (state.route === "new") {
    summary.category = state.routes.new.category;
    summary.ideaStage = state.routes.new.ideaStage;
  } else if (state.route === "deciding") {
    summary.skills = [...state.routes.deciding.skills];
    summary.direction = state.routes.deciding.direction;
  }
  return summary;
}

function setupDefaults(
  state: ScoutOnboardingState,
  summary: ScoutOnboardingSummary,
): ScoutSetupDraft {
  const draft = state.setupDrafts[summary.route];
  // A free-form idea, category label, or business description is not an
  // owner-approved name. Only an explicit signup business name may seed this
  // field; otherwise the owner sees a blank editable value.
  const defaultName =
    summary.route === "existing"
      ? nonBlank(state.signupContext.businessName ?? "")
      : "";
  const defaultDescription = nonBlank(
    [summary.businessOrIdea, summary.priority].filter(Boolean).join(" · "),
  );
  return {
    ...draft,
    name: draft.nameEdited ? draft.name : nonBlank(draft.name, defaultName),
    description: draft.descriptionEdited
      ? draft.description
      : nonBlank(draft.description, defaultDescription),
  };
}

function frozenSummary(
  summary: ScoutOnboardingSummary,
): ScoutOnboardingSummary {
  return Object.freeze({
    ...summary,
    unknowns: Object.freeze([...summary.unknowns]),
    ...(summary.skills ? { skills: Object.freeze([...summary.skills]) } : {}),
  });
}

/**
 * Build a frozen snapshot for the runtime setup callback.
 *
 * The view captures this object before dispatching the in-flight action, so a
 * later owner edit cannot change the answers being saved by an earlier call.
 */
export function getScoutSetupInput(
  state: ScoutOnboardingState,
): ScoutSetupInput | null {
  const summary = getScoutOnboardingSummary(state);
  if (!summary || state.understanding.status !== "confirmed") return null;
  const frozen = frozenSummary(summary);
  const draft = setupDefaults(state, frozen);
  return Object.freeze({
    route: frozen.route,
    summary: frozen,
    setupName: draft.name,
    setupDescription: draft.description,
  });
}

export function scoutRouteLabel(route: ScoutRoute | null) {
  if (route === "new") return "Start a new business";
  if (route === "existing") return "Help with my existing business";
  if (route === "deciding") return "Help me decide what to start";
  return "Choose a starting point";
}

export function scoutCategoryLabel(category: NewRouteState["category"]) {
  return category ? CATEGORY_LABELS[category] : "";
}

export function scoutIdeaStageLabel(stage: NewRouteState["ideaStage"]) {
  return stage ? STAGE_LABELS[stage] : "";
}

export function scoutDirectionLabel(direction: string) {
  return (
    DIRECTION_LABELS[direction as keyof typeof DIRECTION_LABELS] ?? direction
  );
}

export function scoutPriorityLabel(priority: string) {
  return PRIORITY_LABELS[priority] ?? priority;
}

export function scoutStageNumber(stage: ScoutOnboardingState["stage"]) {
  return ONBOARDING_STAGES.indexOf(stage) + 1;
}
