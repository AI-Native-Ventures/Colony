import type {
  ExistingWebsiteState,
  NewRouteState,
  ScoutOnboardingAction,
  ScoutOnboardingState,
  ScoutRoute,
} from "./types";
import {
  CATEGORY_IDS,
  DECIDE_DIRECTION_IDS,
  DECIDE_PRIORITY_IDS,
  EXISTING_PRIORITY_IDS,
  NEW_PRIORITY_IDS,
  NEW_STAGE_IDS,
  emptyProgress,
  knownValue,
} from "./constants";
import { getScoutSetupInput, isScoutRouteComplete } from "./selectors";

function clearNotice(state: ScoutOnboardingState) {
  return state.notice === null ? state : { ...state, notice: null };
}

function withNotice(state: ScoutOnboardingState, notice: string) {
  return { ...state, notice };
}

function resetSetup(state: ScoutOnboardingState) {
  return {
    ...state,
    understanding: { status: "draft" as const },
    setup: {
      phase: "idle" as const,
      requestId: null,
      input: null,
      error: null,
      proof: null,
    },
  };
}

/**
 * Invalidate a confirmed readback when an owner changes a fact.
 *
 * A route edit made before confirmation keeps the owner on the same question.
 * An edit made after confirmation returns to the readback so the setup
 * proposal cannot silently use an older understanding.
 */
function invalidateAfterEdit(
  state: ScoutOnboardingState,
  returnToUnderstanding = false,
) {
  const shouldReturn =
    returnToUnderstanding ||
    state.understanding.status === "confirmed" ||
    state.setup.phase !== "idle" ||
    state.stage === "ready";
  const reset = resetSetup(state);
  return {
    ...reset,
    stage: shouldReturn ? ("understanding" as const) : reset.stage,
    notice: null,
  };
}

function markEdited<T extends { edited: object }>(route: T, field: string): T {
  return {
    ...route,
    edited: { ...route.edited, [field]: true },
  } as T;
}

function resetRouteProgress(
  state: ScoutOnboardingState,
  route: ScoutRoute,
  level: "intake" | "middle" | "priority",
) {
  if (route === "new") {
    const current = state.routes.new;
    const progress =
      level === "intake"
        ? emptyProgress()
        : level === "middle"
          ? {
              ...current.progress,
              middleCompleted: false,
              priorityCompleted: false,
            }
          : { ...current.progress, priorityCompleted: false };
    return {
      ...state,
      routes: { ...state.routes, new: { ...current, progress } },
    };
  }
  if (route === "existing") {
    const current = state.routes.existing;
    const progress =
      level === "intake"
        ? emptyProgress()
        : level === "middle"
          ? {
              ...current.progress,
              middleCompleted: false,
              priorityCompleted: false,
            }
          : { ...current.progress, priorityCompleted: false };
    return {
      ...state,
      routes: {
        ...state.routes,
        existing: {
          ...current,
          confirmed: level === "intake" ? false : current.confirmed,
          progress,
        },
      },
    };
  }
  const current = state.routes.deciding;
  const progress =
    level === "intake"
      ? emptyProgress()
      : level === "middle"
        ? {
            ...current.progress,
            middleCompleted: false,
            priorityCompleted: false,
          }
        : { ...current.progress, priorityCompleted: false };
  return {
    ...state,
    routes: { ...state.routes, deciding: { ...current, progress } },
  };
}

function newFieldLevel(
  field: keyof Pick<
    NewRouteState,
    | "person"
    | "category"
    | "description"
    | "idea"
    | "ideaStage"
    | "goal"
    | "priority"
    | "location"
  >,
): "intake" | "middle" | "priority" {
  if (field === "idea" || field === "ideaStage") return "middle";
  if (field === "goal" || field === "priority" || field === "location") {
    return "priority";
  }
  return "intake";
}

function existingFieldLevel(
  field: "person" | "business" | "website" | "goal" | "priority",
): "intake" | "middle" | "priority" {
  // Goal is an optional note inside the follow-up stage. Editing it must not
  // erase the stage completion that got the owner to the priority choice.
  if (field === "goal" || field === "priority") return "priority";
  return "intake";
}

function decidingFieldLevel(
  field: "person" | "skills" | "direction" | "priority",
): "intake" | "middle" | "priority" {
  if (field === "direction") return "middle";
  if (field === "priority") return "priority";
  return "intake";
}

function setNewAnswer(
  state: ScoutOnboardingState,
  field: keyof Pick<
    NewRouteState,
    | "person"
    | "category"
    | "description"
    | "idea"
    | "ideaStage"
    | "goal"
    | "priority"
    | "location"
  >,
  value: string,
) {
  const route = state.routes.new;
  const nextValue =
    field === "category"
      ? knownValue(CATEGORY_IDS, value)
      : field === "ideaStage"
        ? knownValue(NEW_STAGE_IDS, value)
        : field === "priority"
          ? knownValue(NEW_PRIORITY_IDS, value)
          : value;
  const nextRoute = markEdited({ ...route, [field]: nextValue }, field);
  const next = {
    ...state,
    routes: { ...state.routes, new: nextRoute },
  };
  return resetRouteProgress(
    invalidateAfterEdit(next),
    "new",
    newFieldLevel(field),
  );
}

function setExistingAnswer(
  state: ScoutOnboardingState,
  field: "person" | "business" | "website" | "goal" | "priority",
  value: string,
) {
  const route = state.routes.existing;
  const nextValue =
    field === "priority" ? knownValue(EXISTING_PRIORITY_IDS, value) : value;
  const nextRoute = markEdited(
    {
      ...route,
      [field]: nextValue,
      ...(field === "business"
        ? { businessEditing: true, confirmed: false }
        : {}),
      ...(field === "website"
        ? {
            websiteEditing: true,
            websiteState:
              value.trim().length > 0
                ? ("provided" as const)
                : ("unknown" as const),
          }
        : {}),
    },
    field,
  );
  const next = {
    ...state,
    routes: { ...state.routes, existing: nextRoute },
  };
  return resetRouteProgress(
    invalidateAfterEdit(next),
    "existing",
    existingFieldLevel(field),
  );
}

function setUnderstandingAnswer(
  state: ScoutOnboardingState,
  field:
    | "person"
    | "businessOrIdea"
    | "priority"
    | "ideaStage"
    | "website"
    | "location",
  value: string,
) {
  if (state.route === "new") {
    const route = state.routes.new;
    const nextRoute =
      field === "person"
        ? markEdited({ ...route, person: value }, "person")
        : field === "businessOrIdea"
          ? markEdited({ ...route, idea: value }, "idea")
          : field === "priority"
            ? markEdited({ ...route, goal: value }, "goal")
            : field === "ideaStage"
              ? markEdited(
                  { ...route, ideaStage: knownValue(NEW_STAGE_IDS, value) },
                  "ideaStage",
                )
              : field === "location"
                ? markEdited({ ...route, location: value }, "location")
                : route;
    return invalidateAfterEdit(
      { ...state, routes: { ...state.routes, new: nextRoute } },
      true,
    );
  }
  if (state.route === "existing") {
    if (field === "website") {
      const websiteState: ExistingWebsiteState = value.trim()
        ? "provided"
        : "unknown";
      const route = markEdited(
        {
          ...state.routes.existing,
          website: value,
          websiteState,
          websiteEditing: true,
        },
        "website",
      );
      return invalidateAfterEdit(
        { ...state, routes: { ...state.routes, existing: route } },
        true,
      );
    }
    const route = state.routes.existing;
    const nextRoute =
      field === "person"
        ? markEdited({ ...route, person: value }, "person")
        : field === "businessOrIdea"
          ? markEdited(
              { ...route, business: value, businessEditing: true },
              "business",
            )
          : field === "priority"
            ? markEdited({ ...route, goal: value }, "goal")
            : route;
    return invalidateAfterEdit(
      { ...state, routes: { ...state.routes, existing: nextRoute } },
      true,
    );
  }
  const route = state.routes.deciding;
  const nextRoute =
    field === "person"
      ? markEdited({ ...route, person: value }, "person")
      : field === "businessOrIdea"
        ? markEdited({ ...route, direction: value }, "direction")
        : route;
  return invalidateAfterEdit(
    { ...state, routes: { ...state.routes, deciding: nextRoute } },
    true,
  );
}

function validation(state: ScoutOnboardingState, message: string) {
  return withNotice(state, message);
}

/** Pure state transition function used by the inline React view and integration. */
export function scoutOnboardingReducer(
  state: ScoutOnboardingState,
  action: ScoutOnboardingAction,
): ScoutOnboardingState {
  switch (action.type) {
    case "select-route":
      return resetSetup({
        ...state,
        route: action.route,
        stage: "person",
        notice: null,
      });

    case "set-new-answer":
      return setNewAnswer(state, action.field, action.value);

    case "advance-new-intake": {
      const route = state.routes.new;
      if (!route.category)
        return validation(state, "Choose a business category first.");
      if (route.category === "other" && !route.description.trim()) {
        return validation(
          state,
          "Add a short description so Scout understands the category.",
        );
      }
      return {
        ...clearNotice(state),
        stage: "business",
        routes: {
          ...state.routes,
          new: {
            ...route,
            progress: {
              ...route.progress,
              intakeCompleted: true,
              middleCompleted: false,
              priorityCompleted: false,
            },
          },
        },
      };
    }

    case "advance-new-business": {
      const route = state.routes.new;
      if (!route.progress.intakeCompleted) {
        return validation(
          state,
          "Choose the new business category before continuing.",
        );
      }
      if (!route.ideaStage)
        return validation(state, "Choose the idea stage first.");
      return {
        ...clearNotice(state),
        stage: "follow-up",
        routes: {
          ...state.routes,
          new: {
            ...route,
            progress: {
              ...route.progress,
              middleCompleted: true,
              priorityCompleted: false,
            },
          },
        },
      };
    }

    case "advance-new-follow-up": {
      const route = state.routes.new;
      if (!route.priority)
        return validation(state, "Choose the priority that matters first.");
      return {
        ...clearNotice(state),
        stage: "understanding",
        routes: {
          ...state.routes,
          new: {
            ...route,
            progress: { ...route.progress, priorityCompleted: true },
          },
        },
      };
    }

    case "set-existing-answer":
      return setExistingAnswer(state, action.field, action.value);

    case "set-existing-website-state": {
      const value: ExistingWebsiteState = action.value;
      const route = markEdited(
        {
          ...state.routes.existing,
          website: value === "provided" ? state.routes.existing.website : "",
          websiteState: value,
          websiteEditing: value === "unknown",
        },
        "website",
      );
      return invalidateAfterEdit(
        { ...state, routes: { ...state.routes, existing: route } },
        true,
      );
    }

    case "set-existing-business-editing": {
      const route = {
        ...state.routes.existing,
        businessEditing: action.value,
      };
      return invalidateAfterEdit(
        { ...state, routes: { ...state.routes, existing: route } },
        action.value,
      );
    }

    case "set-existing-website-editing": {
      const route = {
        ...state.routes.existing,
        websiteEditing: action.value,
      };
      return invalidateAfterEdit(
        { ...state, routes: { ...state.routes, existing: route } },
        action.value,
      );
    }

    case "confirm-existing": {
      const route = state.routes.existing;
      if (!route.business.trim()) {
        return validation(
          state,
          "Add the existing business details before confirming.",
        );
      }
      return {
        ...clearNotice(state),
        stage: "business",
        routes: {
          ...state.routes,
          existing: {
            ...route,
            businessEditing: false,
            confirmed: true,
            progress: {
              ...route.progress,
              intakeCompleted: true,
              middleCompleted: false,
              priorityCompleted: false,
            },
          },
        },
      };
    }

    case "advance-existing-business": {
      const route = state.routes.existing;
      if (!route.confirmed) {
        return validation(
          state,
          "Confirm the existing business before continuing.",
        );
      }
      return {
        ...clearNotice(state),
        stage: "follow-up",
        routes: {
          ...state.routes,
          existing: {
            ...route,
            progress: {
              ...route.progress,
              middleCompleted: true,
              priorityCompleted: false,
            },
          },
        },
      };
    }

    case "advance-existing-follow-up": {
      const route = state.routes.existing;
      if (!route.priority)
        return validation(state, "Choose the priority that matters first.");
      return {
        ...clearNotice(state),
        stage: "understanding",
        routes: {
          ...state.routes,
          existing: {
            ...route,
            progress: { ...route.progress, priorityCompleted: true },
          },
        },
      };
    }

    case "set-deciding-person": {
      const route = markEdited(
        { ...state.routes.deciding, person: action.value },
        "person",
      );
      return resetRouteProgress(
        invalidateAfterEdit({
          ...state,
          routes: { ...state.routes, deciding: route },
        }),
        "deciding",
        decidingFieldLevel("person"),
      );
    }

    case "toggle-deciding-skill": {
      const route = state.routes.deciding;
      const skills = route.skills.includes(action.skill)
        ? route.skills.filter((skill) => skill !== action.skill)
        : [...route.skills, action.skill];
      const nextRoute = markEdited({ ...route, skills }, "skills");
      return resetRouteProgress(
        invalidateAfterEdit({
          ...state,
          routes: { ...state.routes, deciding: nextRoute },
        }),
        "deciding",
        decidingFieldLevel("skills"),
      );
    }

    case "advance-deciding-intake": {
      const route = state.routes.deciding;
      if (!route.skills.length) {
        return validation(
          state,
          "Choose at least one skill, experience, or interest.",
        );
      }
      return {
        ...clearNotice(state),
        stage: "business",
        routes: {
          ...state.routes,
          deciding: {
            ...route,
            progress: {
              ...route.progress,
              intakeCompleted: true,
              middleCompleted: false,
              priorityCompleted: false,
            },
          },
        },
      };
    }

    case "set-deciding-direction": {
      const direction = knownValue(DECIDE_DIRECTION_IDS, action.value);
      const route = markEdited(
        { ...state.routes.deciding, direction },
        "direction",
      );
      return resetRouteProgress(
        invalidateAfterEdit({
          ...state,
          routes: { ...state.routes, deciding: route },
        }),
        "deciding",
        decidingFieldLevel("direction"),
      );
    }

    case "advance-deciding-business": {
      const route = state.routes.deciding;
      if (!route.direction.trim())
        return validation(state, "Choose a direction to explore.");
      return {
        ...clearNotice(state),
        stage: "follow-up",
        routes: {
          ...state.routes,
          deciding: {
            ...route,
            progress: {
              ...route.progress,
              middleCompleted: true,
              priorityCompleted: false,
            },
          },
        },
      };
    }

    case "set-deciding-priority": {
      const route = markEdited(
        {
          ...state.routes.deciding,
          priority: knownValue(DECIDE_PRIORITY_IDS, action.value),
        },
        "priority",
      );
      return resetRouteProgress(
        invalidateAfterEdit({
          ...state,
          routes: { ...state.routes, deciding: route },
        }),
        "deciding",
        decidingFieldLevel("priority"),
      );
    }

    case "advance-deciding-follow-up": {
      const route = state.routes.deciding;
      if (!route.priority)
        return validation(state, "Choose the focus that matters first.");
      return {
        ...clearNotice(state),
        stage: "understanding",
        routes: {
          ...state.routes,
          deciding: {
            ...route,
            progress: { ...route.progress, priorityCompleted: true },
          },
        },
      };
    }

    case "set-understanding-answer":
      return setUnderstandingAnswer(state, action.field, action.value);

    case "confirm-understanding": {
      if (!isScoutRouteComplete(state)) {
        return validation(
          state,
          "Finish the route-specific choices before confirming the understanding.",
        );
      }
      return {
        ...clearNotice(state),
        stage: "setup",
        understanding: { status: "confirmed" },
        setup: {
          phase: "idle",
          requestId: null,
          input: null,
          error: null,
          proof: null,
        },
      };
    }

    case "set-setup-draft": {
      if (!state.route) return state;
      const draft = state.setupDrafts[state.route];
      return {
        ...clearNotice(state),
        setupDrafts: {
          ...state.setupDrafts,
          [state.route]: {
            ...draft,
            [action.field]: action.value,
            ...(action.field === "name" ? { nameEdited: true } : {}),
            ...(action.field === "description"
              ? { descriptionEdited: true }
              : {}),
          },
        },
      };
    }

    case "approve-setup-started": {
      if (state.setup.phase === "saving") return state;
      const input = getScoutSetupInput(state);
      if (!input) {
        return validation(
          state,
          "Confirm the understanding before approving setup.",
        );
      }
      if (!action.requestId.trim())
        return validation(state, "A setup request id is required.");
      return {
        ...clearNotice(state),
        stage: "setting-up",
        setup: {
          phase: "saving",
          requestId: action.requestId,
          input,
          error: null,
          proof: null,
        },
      };
    }

    case "approve-setup-succeeded": {
      if (
        state.setup.phase !== "saving" ||
        state.setup.requestId !== action.requestId
      ) {
        return state;
      }
      if (!action.proof.proofId.trim()) {
        return {
          ...state,
          setup: {
            phase: "error",
            requestId: state.setup.requestId,
            input: state.setup.input,
            error: "We could not confirm that setup finished. Try again.",
            proof: null,
          },
          notice: "We could not confirm that setup finished. Try again.",
        };
      }
      return {
        ...clearNotice(state),
        stage: "ready",
        setup: {
          phase: "ready",
          requestId: null,
          input: state.setup.input,
          error: null,
          proof: action.proof,
        },
      };
    }

    case "approve-setup-failed": {
      if (
        state.setup.phase !== "saving" ||
        state.setup.requestId !== action.requestId
      ) {
        return state;
      }
      const message = action.error.trim() || "Setup could not be saved.";
      return {
        ...state,
        stage: "setting-up",
        setup: {
          phase: "error",
          requestId: state.setup.requestId,
          input: state.setup.input,
          error: message,
          proof: null,
        },
        notice: message,
      };
    }

    case "go-back": {
      if (state.setup.phase === "saving") return state;
      const next =
        action.stage === "setup" && state.setup.phase === "error"
          ? {
              ...state,
              setup: {
                phase: "idle" as const,
                requestId: null,
                input: null,
                error: null,
                proof: null,
              },
              notice: null,
            }
          : clearNotice(state);
      return { ...next, stage: action.stage };
    }

    case "clear-notice":
      return clearNotice(state);

    default:
      return state;
  }
}
