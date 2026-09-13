import type {
  DecideDirection,
  DecidePriority,
  ExistingBusinessPriority,
  ExistingWebsiteState,
  NewBusinessCategory,
  NewBusinessPriority,
  NewBusinessStage,
  ScoutOnboardingStage,
  ScoutRouteProgress,
  ScoutSignupContext,
  ScoutSkill,
} from "./types";

export const SCOUT_ONBOARDING_STATE_VERSION = 1 as const;

export const CATEGORY_LABELS: Record<NewBusinessCategory, string> = {
  "local-services": "Local services",
  professional: "Professional services",
  products: "Products and retail",
  digital: "Online and digital",
  other: "Something else",
};

export const STAGE_LABELS: Record<NewBusinessStage, string> = {
  idea: "Still an idea",
  preparing: "Preparing to begin",
  testing: "Testing a small direction",
};

export const DIRECTION_LABELS: Record<DecideDirection, string> = {
  experience: "A service built around my experience",
  group: "A focused offer for a clear group",
  flexible: "A flexible, low-risk start",
  project: "A project-based business",
  "still-exploring": "Still exploring",
};

export const PRIORITY_LABELS: Record<string, string> = {
  demand: "Learn whether people want it",
  offer: "Shape the first offer",
  test: "Plan a small first test",
  customers: "Get more customers",
  delivery: "Make delivery easier",
  next: "Decide what to do next",
  compare: "Compare a few directions",
  clarify: "Clarify what I want",
  other: "Something else to discuss",
};

export const SKILL_IDS: readonly ScoutSkill[] = [
  "operations",
  "people",
  "making",
  "teaching",
  "organizing",
  "curious",
];

export const CATEGORY_IDS: readonly NewBusinessCategory[] = [
  "local-services",
  "professional",
  "products",
  "digital",
  "other",
];

export const NEW_STAGE_IDS: readonly NewBusinessStage[] = [
  "idea",
  "preparing",
  "testing",
];

export const NEW_PRIORITY_IDS: readonly NewBusinessPriority[] = [
  "demand",
  "offer",
  "test",
  "other",
];

export const EXISTING_PRIORITY_IDS: readonly ExistingBusinessPriority[] = [
  "customers",
  "delivery",
  "next",
  "other",
];

export const DECIDE_DIRECTION_IDS: readonly DecideDirection[] = [
  "experience",
  "group",
  "flexible",
  "project",
  "still-exploring",
];

export const DECIDE_PRIORITY_IDS: readonly DecidePriority[] = [
  "compare",
  "test",
  "clarify",
];

export const ONBOARDING_STAGES: readonly ScoutOnboardingStage[] = [
  "arrival",
  "person",
  "business",
  "follow-up",
  "understanding",
  "setup",
  "setting-up",
  "ready",
];

export function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function nonBlank(...values: string[]) {
  return values.find((value) => value.trim().length > 0) ?? "";
}

export function knownValue<T extends string>(
  values: readonly T[],
  value: unknown,
): T | "" {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : "";
}

export function normalizeContext(context: ScoutSignupContext | undefined) {
  const suppliedWebsite = text(context?.website);
  const websiteState: ExistingWebsiteState =
    context?.websiteState === "none"
      ? "none"
      : context?.websiteState === "provided" &&
          suppliedWebsite.trim().length > 0
        ? "provided"
        : suppliedWebsite.trim().length > 0
          ? "provided"
          : "unknown";
  return {
    ownerName: text(context?.ownerName),
    ownerNote: text(context?.ownerNote),
    businessName: text(context?.businessName),
    businessDescription: text(context?.businessDescription),
    website: websiteState === "none" ? "" : suppliedWebsite,
    websiteState,
  };
}

export type NormalizedSignupContext = ReturnType<typeof normalizeContext>;

export function ownerSeed(context: NormalizedSignupContext) {
  return nonBlank(context.ownerNote, context.ownerName);
}

export function businessSeed(context: NormalizedSignupContext) {
  if (context.businessName && context.businessDescription) {
    return `${context.businessName} — ${context.businessDescription}`;
  }
  return nonBlank(context.businessName, context.businessDescription);
}

export function emptyProgress(): ScoutRouteProgress {
  return {
    intakeCompleted: false,
    middleCompleted: false,
    priorityCompleted: false,
  };
}

export function isKnownSkill(value: unknown): value is ScoutSkill {
  return typeof value === "string" && SKILL_IDS.includes(value as ScoutSkill);
}
