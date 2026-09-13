/**
 * The owner-facing routes in Scout's first Welcome conversation.
 *
 * The route, relay, channel, identity, and root event are intentionally not
 * part of this contract. The integration owns those boundaries and supplies them to
 * the persistence callback when it is ready to write a signed record.
 */
export type ScoutRoute = "new" | "existing" | "deciding";

export type ScoutOnboardingStage =
  | "arrival"
  | "person"
  | "business"
  | "follow-up"
  | "understanding"
  | "setup"
  | "setting-up"
  | "ready";

export type NewBusinessCategory =
  | "local-services"
  | "professional"
  | "products"
  | "digital"
  | "other";

export type NewBusinessStage = "idea" | "preparing" | "testing";

export type NewBusinessPriority = "demand" | "offer" | "test" | "other";

export type ExistingBusinessPriority =
  | "customers"
  | "delivery"
  | "next"
  | "other";

export type ScoutSkill =
  | "operations"
  | "people"
  | "making"
  | "teaching"
  | "organizing"
  | "curious";

export type DecideDirection =
  | "experience"
  | "group"
  | "flexible"
  | "project"
  | "still-exploring";

export type DecidePriority = "compare" | "test" | "clarify";

export type ExistingWebsiteState = "unknown" | "provided" | "none";

export type ScoutPriorityId =
  | NewBusinessPriority
  | ExistingBusinessPriority
  | DecidePriority;

/** Known details from signup. Empty strings remain valid owner values. */
export type ScoutSignupContext = {
  ownerName?: string | null;
  ownerNote?: string | null;
  businessName?: string | null;
  businessDescription?: string | null;
  website?: string | null;
  /** Preserve an explicit signup choice that the owner has no website. */
  websiteState?: ExistingWebsiteState | null;
};

export type ScoutRouteProgress = {
  intakeCompleted: boolean;
  middleCompleted: boolean;
  priorityCompleted: boolean;
};

export type NewRouteState = {
  person: string;
  category: NewBusinessCategory | "";
  description: string;
  idea: string;
  ideaStage: NewBusinessStage | "";
  goal: string;
  priority: NewBusinessPriority | "";
  location: string;
  edited: Partial<
    Record<
      | "person"
      | "category"
      | "description"
      | "idea"
      | "ideaStage"
      | "goal"
      | "priority"
      | "location",
      true
    >
  >;
  progress: ScoutRouteProgress;
};

export type ExistingRouteState = {
  person: string;
  business: string;
  businessEditing: boolean;
  website: string;
  websiteState: ExistingWebsiteState;
  websiteEditing: boolean;
  goal: string;
  priority: ExistingBusinessPriority | "";
  edited: Partial<
    Record<"person" | "business" | "website" | "goal" | "priority", true>
  >;
  confirmed: boolean;
  progress: ScoutRouteProgress;
};

export type DecidingRouteState = {
  person: string;
  skills: ScoutSkill[];
  /** A selected direction id or the owner's edited words. */
  direction: string;
  priority: DecidePriority | "";
  edited: Partial<Record<"person" | "skills" | "direction" | "priority", true>>;
  progress: ScoutRouteProgress;
};

export type ScoutSetupDraft = {
  name: string;
  description: string;
  nameEdited: boolean;
  descriptionEdited: boolean;
};

export type ScoutSetupPhase = "idle" | "saving" | "error" | "ready";

/** A saved proof returned by the runtime after its actual setup write. */
export type ScoutSetupProof = {
  proofId: string;
  recordIds?: readonly string[];
  savedAt?: string;
  [key: string]: unknown;
};

export type ScoutOnboardingSummary = {
  route: ScoutRoute;
  person: string;
  businessOrIdea: string;
  priority: string;
  priorityId: ScoutPriorityId | "";
  unknowns: readonly string[];
  website: string | null;
  /** Existing-route website choice, including an explicit no-website answer. */
  websiteState: ExistingWebsiteState;
  location: string | null;
  category?: NewBusinessCategory | "";
  ideaStage?: NewBusinessStage | "";
  skills?: readonly ScoutSkill[];
  direction?: string;
};

/** Payload the runtime receives after owner confirmation. */
export type ScoutSetupInput = {
  route: ScoutRoute;
  summary: ScoutOnboardingSummary;
  setupName: string;
  setupDescription: string;
};

export type ScoutOnboardingState = {
  version: 1;
  stage: ScoutOnboardingStage;
  route: ScoutRoute | null;
  signupContext: Required<ScoutSignupContext>;
  routes: {
    new: NewRouteState;
    existing: ExistingRouteState;
    deciding: DecidingRouteState;
  };
  understanding: {
    status: "draft" | "confirmed";
  };
  setupDrafts: Record<ScoutRoute, ScoutSetupDraft>;
  setup: {
    phase: ScoutSetupPhase;
    requestId: string | null;
    /** Snapshot passed to the current or last failed setup operation. */
    input: ScoutSetupInput | null;
    error: string | null;
    proof: ScoutSetupProof | null;
  };
  notice: string | null;
};

export type CreateInitialScoutOnboardingStateOptions = {
  signupContext?: ScoutSignupContext;
};

export type ScoutOnboardingAction =
  | { type: "select-route"; route: ScoutRoute }
  | {
      type: "set-new-answer";
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
      >;
      value: string;
    }
  | { type: "advance-new-intake" }
  | { type: "advance-new-business" }
  | { type: "advance-new-follow-up" }
  | {
      type: "set-existing-answer";
      field: "person" | "business" | "website" | "goal" | "priority";
      value: string;
    }
  | { type: "set-existing-website-state"; value: ExistingWebsiteState }
  | { type: "set-existing-business-editing"; value: boolean }
  | { type: "set-existing-website-editing"; value: boolean }
  | { type: "confirm-existing" }
  | { type: "advance-existing-business" }
  | { type: "advance-existing-follow-up" }
  | { type: "set-deciding-person"; value: string }
  | { type: "toggle-deciding-skill"; skill: ScoutSkill }
  | { type: "advance-deciding-intake" }
  | { type: "set-deciding-direction"; value: DecideDirection }
  | { type: "advance-deciding-business" }
  | { type: "set-deciding-priority"; value: DecidePriority }
  | { type: "advance-deciding-follow-up" }
  | {
      type: "set-understanding-answer";
      field:
        | "person"
        | "businessOrIdea"
        | "priority"
        | "ideaStage"
        | "website"
        | "location";
      value: string;
    }
  | { type: "confirm-understanding" }
  | { type: "set-setup-draft"; field: "name" | "description"; value: string }
  | { type: "approve-setup-started"; requestId: string }
  | {
      type: "approve-setup-succeeded";
      requestId: string;
      proof: ScoutSetupProof;
    }
  | { type: "approve-setup-failed"; requestId: string; error: string }
  | {
      type: "go-back";
      stage: Exclude<ScoutOnboardingStage, "setting-up" | "ready">;
    }
  | { type: "clear-notice" };

export type ScoutOnboardingDispatch = (action: ScoutOnboardingAction) => void;

export type ScoutApproveSetup = (
  input: ScoutSetupInput,
  requestId: string,
) => Promise<ScoutSetupProof>;
