import type {
  CreateInitialScoutOnboardingStateOptions,
  DecidingRouteState,
  ExistingRouteState,
  ExistingWebsiteState,
  NewRouteState,
  ScoutOnboardingState,
  ScoutOnboardingSummary,
  ScoutRoute,
  ScoutRouteProgress,
  ScoutSetupDraft,
  ScoutSetupInput,
  ScoutSetupPhase,
  ScoutSetupProof,
  ScoutSignupContext,
  ScoutSkill,
} from "./types";
import {
  CATEGORY_IDS,
  DECIDE_PRIORITY_IDS,
  EXISTING_PRIORITY_IDS,
  NEW_PRIORITY_IDS,
  NEW_STAGE_IDS,
  ONBOARDING_STAGES,
  SCOUT_ONBOARDING_STATE_VERSION,
  SKILL_IDS,
  emptyProgress,
  knownValue,
  normalizeContext,
  text,
} from "./constants";
import { createInitialScoutOnboardingState } from "./initialState";
import { getScoutSetupInput, isScoutRouteComplete } from "./selectors";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function editedFields(value: unknown, fields: readonly string[]) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    fields
      .filter((field) => value[field] === true)
      .map((field) => [field, true]),
  ) as Record<string, true>;
}

function progressValue(value: unknown): ScoutRouteProgress {
  if (!isRecord(value)) return emptyProgress();
  return {
    intakeCompleted: value.intakeCompleted === true,
    middleCompleted: value.middleCompleted === true,
    priorityCompleted: value.priorityCompleted === true,
  };
}

function setupDraftValue(
  value: unknown,
  fallback: ScoutSetupDraft,
): ScoutSetupDraft {
  if (!isRecord(value)) return fallback;
  return {
    name: text(value.name, fallback.name),
    description: text(value.description, fallback.description),
    nameEdited: value.nameEdited === true,
    descriptionEdited: value.descriptionEdited === true,
  };
}

function proofValue(value: unknown): ScoutSetupProof | null {
  if (
    !isRecord(value) ||
    typeof value.proofId !== "string" ||
    value.proofId.trim().length === 0
  ) {
    return null;
  }
  return value as ScoutSetupProof;
}

function routeValue(value: unknown): ScoutRoute | null {
  return value === "new" || value === "existing" || value === "deciding"
    ? value
    : null;
}

function stageValue(value: unknown) {
  return ONBOARDING_STAGES.includes(value as (typeof ONBOARDING_STAGES)[number])
    ? (value as (typeof ONBOARDING_STAGES)[number])
    : "arrival";
}

function stringOrNull(value: unknown) {
  return typeof value === "string" ? value : value === null ? null : null;
}

function setupInputValue(
  value: unknown,
  expectedRoute: ScoutRoute,
): ScoutSetupInput | null {
  if (!isRecord(value) || routeValue(value.route) !== expectedRoute)
    return null;
  if (!isRecord(value.summary) || !Array.isArray(value.summary.unknowns))
    return null;
  if (!value.summary.unknowns.every((item) => typeof item === "string"))
    return null;
  const summaryRoute = expectedRoute;
  const summary: ScoutOnboardingSummary = {
    route: summaryRoute,
    person: text(value.summary.person),
    businessOrIdea: text(value.summary.businessOrIdea),
    priority: text(value.summary.priority),
    priorityId: text(
      value.summary.priorityId,
    ) as ScoutOnboardingSummary["priorityId"],
    unknowns: [...value.summary.unknowns],
    website: stringOrNull(value.summary.website),
    websiteState:
      value.summary.websiteState === "provided" ||
      value.summary.websiteState === "none" ||
      value.summary.websiteState === "unknown"
        ? value.summary.websiteState
        : stringOrNull(value.summary.website) === null
          ? "unknown"
          : "provided",
    location: stringOrNull(value.summary.location),
  };
  if (summaryRoute === "new") {
    summary.category = knownValue(CATEGORY_IDS, value.summary.category);
    summary.ideaStage = knownValue(NEW_STAGE_IDS, value.summary.ideaStage);
  } else if (summaryRoute === "deciding") {
    summary.skills = Array.isArray(value.summary.skills)
      ? value.summary.skills.filter((skill): skill is ScoutSkill =>
          SKILL_IDS.includes(skill as ScoutSkill),
        )
      : [];
    summary.direction = text(value.summary.direction);
  }
  return {
    route: summaryRoute,
    summary,
    setupName: text(value.setupName),
    setupDescription: text(value.setupDescription),
  };
}

function sanitizeState(
  value: Record<string, unknown>,
  options: CreateInitialScoutOnboardingStateOptions,
): ScoutOnboardingState {
  const parsedContext = isRecord(value.signupContext)
    ? normalizeContext(value.signupContext as ScoutSignupContext)
    : normalizeContext(options.signupContext);
  const fallback = createInitialScoutOnboardingState({
    signupContext: parsedContext,
  });
  const routes = isRecord(value.routes) ? value.routes : {};
  const parsedNew = isRecord(routes.new) ? routes.new : {};
  const parsedExisting = isRecord(routes.existing) ? routes.existing : {};
  const parsedDeciding = isRecord(routes.deciding) ? routes.deciding : {};

  const newRoute: NewRouteState = {
    ...fallback.routes.new,
    person: text(parsedNew.person, fallback.routes.new.person),
    category: knownValue(CATEGORY_IDS, parsedNew.category),
    description: text(parsedNew.description),
    idea: text(parsedNew.idea),
    ideaStage: knownValue(NEW_STAGE_IDS, parsedNew.ideaStage),
    goal: text(parsedNew.goal),
    priority: knownValue(NEW_PRIORITY_IDS, parsedNew.priority),
    location: text(parsedNew.location),
    edited: editedFields(parsedNew.edited, [
      "person",
      "category",
      "description",
      "idea",
      "ideaStage",
      "goal",
      "priority",
      "location",
    ]),
    progress: progressValue(parsedNew.progress),
  };

  const website = text(
    parsedExisting.website,
    fallback.routes.existing.website,
  );
  const parsedWebsiteState: ExistingWebsiteState =
    parsedExisting.websiteState === "provided" ||
    parsedExisting.websiteState === "none"
      ? parsedExisting.websiteState
      : website.trim().length > 0
        ? "provided"
        : fallback.routes.existing.websiteState;
  const existingRoute: ExistingRouteState = {
    ...fallback.routes.existing,
    person: text(parsedExisting.person, fallback.routes.existing.person),
    business: text(parsedExisting.business),
    businessEditing:
      typeof parsedExisting.businessEditing === "boolean"
        ? parsedExisting.businessEditing
        : fallback.routes.existing.businessEditing,
    website: parsedWebsiteState === "none" ? "" : website,
    websiteState: parsedWebsiteState,
    websiteEditing:
      typeof parsedExisting.websiteEditing === "boolean"
        ? parsedExisting.websiteEditing
        : fallback.routes.existing.websiteEditing,
    goal: text(parsedExisting.goal),
    priority: knownValue(EXISTING_PRIORITY_IDS, parsedExisting.priority),
    edited: editedFields(parsedExisting.edited, [
      "person",
      "business",
      "website",
      "goal",
      "priority",
    ]),
    confirmed: parsedExisting.confirmed === true,
    progress: progressValue(parsedExisting.progress),
  };

  const skills = Array.isArray(parsedDeciding.skills)
    ? parsedDeciding.skills.filter((skill): skill is ScoutSkill =>
        SKILL_IDS.includes(skill as ScoutSkill),
      )
    : [];
  const decidingRoute: DecidingRouteState = {
    ...fallback.routes.deciding,
    person: text(parsedDeciding.person, fallback.routes.deciding.person),
    skills: [...new Set(skills)],
    direction:
      typeof parsedDeciding.direction === "string"
        ? parsedDeciding.direction
        : "",
    priority: knownValue(DECIDE_PRIORITY_IDS, parsedDeciding.priority),
    edited: editedFields(parsedDeciding.edited, [
      "person",
      "skills",
      "direction",
      "priority",
    ]),
    progress: progressValue(parsedDeciding.progress),
  };

  const parsedUnderstanding = isRecord(value.understanding)
    ? value.understanding
    : {};
  const parsedSetupDrafts = isRecord(value.setupDrafts)
    ? value.setupDrafts
    : {};
  const setupDrafts = {
    new: setupDraftValue(parsedSetupDrafts.new, fallback.setupDrafts.new),
    existing: setupDraftValue(
      parsedSetupDrafts.existing,
      fallback.setupDrafts.existing,
    ),
    deciding: setupDraftValue(
      parsedSetupDrafts.deciding,
      fallback.setupDrafts.deciding,
    ),
  };
  const parsedSetup = isRecord(value.setup) ? value.setup : {};
  const parsedProof = proofValue(parsedSetup.proof);
  const interrupted = parsedSetup.phase === "saving";
  const parsedPhase: ScoutSetupPhase =
    parsedSetup.phase === "ready" && parsedProof
      ? "ready"
      : parsedSetup.phase === "error" || interrupted
        ? "error"
        : "idle";
  const route = routeValue(value.route);
  const stage = stageValue(value.stage);
  const routeState = {
    ...fallback,
    route,
    routes: { new: newRoute, existing: existingRoute, deciding: decidingRoute },
  };
  const completeUnderstanding =
    parsedUnderstanding.status === "confirmed" &&
    route !== null &&
    isScoutRouteComplete(routeState);
  const parsedRequestId = text(parsedSetup.requestId) || null;
  const setupError =
    parsedPhase === "error"
      ? interrupted
        ? "Setup was interrupted. Try again."
        : text(parsedSetup.error, "Setup could not be saved.")
      : null;
  const savedSetup = {
    phase: parsedPhase,
    requestId: parsedPhase === "ready" ? null : parsedRequestId,
    input: null as ScoutSetupInput | null,
    error: setupError,
    proof: parsedPhase === "ready" ? parsedProof : null,
  };
  const provisional: ScoutOnboardingState = {
    ...fallback,
    stage:
      parsedPhase === "ready"
        ? "ready"
        : parsedPhase === "error"
          ? "setting-up"
          : stage === "ready"
            ? completeUnderstanding
              ? "setup"
              : "understanding"
            : completeUnderstanding && stage === "arrival"
              ? "setup"
              : stage,
    route,
    signupContext: parsedContext,
    routes: { new: newRoute, existing: existingRoute, deciding: decidingRoute },
    understanding: { status: completeUnderstanding ? "confirmed" : "draft" },
    setupDrafts,
    setup: savedSetup,
    notice: text(value.notice) || null,
  };
  const persistedInput = route
    ? setupInputValue(parsedSetup.input, route)
    : null;
  const retryInput =
    persistedInput ??
    (parsedPhase !== "idle" ? getScoutSetupInput(provisional) : null);
  return {
    ...provisional,
    setup: { ...savedSetup, input: retryInput },
  };
}

/** Serialize only JSON-safe onboarding state for runtime persistence. */
export function serializeScoutOnboardingState(state: ScoutOnboardingState) {
  return JSON.stringify({ ...state, version: SCOUT_ONBOARDING_STATE_VERSION });
}

/** Restore persisted state, falling back to a fresh, context-seeded draft. */
export function deserializeScoutOnboardingState(
  serialized: string | null | undefined,
  options: CreateInitialScoutOnboardingStateOptions = {},
): ScoutOnboardingState {
  if (!serialized) return createInitialScoutOnboardingState(options);
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      !isRecord(parsed) ||
      parsed.version !== SCOUT_ONBOARDING_STATE_VERSION
    ) {
      return createInitialScoutOnboardingState(options);
    }
    return sanitizeState(parsed, options);
  } catch {
    return createInitialScoutOnboardingState(options);
  }
}
