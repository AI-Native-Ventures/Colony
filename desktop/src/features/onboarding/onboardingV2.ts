export const ONBOARDING_V2_VERSION = 2 as const;

export const FOUNDER_GENDERS = [
  "woman",
  "man",
  "non-binary",
  "self-describe",
  "prefer-not-to-say",
] as const;

export type FounderGender = (typeof FOUNDER_GENDERS)[number];

export type OnboardingCreditStatus = "active" | "depleted" | "unavailable";

/** Completion intent for a v2 signup. Missing is tolerated only before migration. */
export type OnboardingFirstTaskMode = "suggestion" | "choice";

export const ONBOARDING_V2_STAGES = [
  "founder",
  "company",
  "scout-task",
  "entering",
] as const;

export type OnboardingV2Stage = (typeof ONBOARDING_V2_STAGES)[number];

export type OnboardingV2Draft = {
  version: typeof ONBOARDING_V2_VERSION;
  stage: OnboardingV2Stage;
  founder: {
    fullName: string;
    country: string;
    city: string;
    gender: FounderGender | null;
    selfDescribedGender: string;
  };
  company: {
    /** Confirmed business name supplied by the simplified founder flow. */
    name?: string;
    website: string;
    hasWebsite: boolean;
    canonicalUrl: string;
    summary: string;
    scanStatus: "idle" | "running" | "success" | "failed" | "timeout";
  };
  runtime: {
    selectedId: string | null;
    route: "cli" | "colony-agent" | null;
    model: string;
  };
  credits: {
    balanceNanousd: string | null;
    status: OnboardingCreditStatus;
  };
  firstTask: {
    /** Absent for legacy drafts, which retain their original completion path. */
    mode?: OnboardingFirstTaskMode;
    content: string;
    deliveryMarker: string;
    deliveredEventId: string | null;
  };
};

export function createOnboardingV2Draft(): OnboardingV2Draft {
  return {
    version: ONBOARDING_V2_VERSION,
    stage: "founder",
    founder: {
      fullName: "",
      country: "",
      city: "",
      gender: null,
      selfDescribedGender: "",
    },
    company: {
      website: "",
      hasWebsite: true,
      canonicalUrl: "",
      summary: "",
      scanStatus: "idle",
    },
    runtime: {
      selectedId: null,
      route: null,
      model: "deepseek-v4-flash",
    },
    credits: {
      balanceNanousd: null,
      status: "unavailable",
    },
    firstTask: {
      // Every newly-created current signup is choice-first. The v1 migration
      // below explicitly clears this field so shipped legacy drafts retain
      // their original task behavior.
      mode: "choice",
      content: "",
      deliveryMarker: crypto.randomUUID(),
      deliveredEventId: null,
    },
  };
}

export function createAdditionalCommunityOnboardingV2Draft(): OnboardingV2Draft {
  return {
    ...createOnboardingV2Draft(),
    stage: "company",
  };
}

export function normalizeFounderGender(
  value: string | null | undefined,
): FounderGender | null {
  return FOUNDER_GENDERS.includes(value as FounderGender)
    ? (value as FounderGender)
    : null;
}

export function founderDetailsAreValid(
  founder: OnboardingV2Draft["founder"],
): boolean {
  if (
    !founder.fullName.trim() ||
    !founder.country.trim() ||
    !founder.city.trim()
  ) {
    return false;
  }
  return !(
    founder.gender === "self-describe" &&
    founder.selfDescribedGender.trim().length === 0
  );
}

export function isValidBusinessWebsite(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host === "0.0.0.0" ||
      host === "::1" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host)
    ) {
      return false;
    }
    const [first, second] = host.split(".").map(Number);
    if (first === 172 && second >= 16 && second <= 31) return false;
    return host.length > 0 && !url.hash;
  } catch {
    return false;
  }
}

/**
 * The website scan runs in the background of the company screen: it never
 * gates progress, so it may start whenever that screen (or any later one) is
 * showing and no scan has run yet.
 */
export function shouldStartWebsiteScan(
  stage: OnboardingV2Stage,
  status: OnboardingV2Draft["company"]["scanStatus"],
): boolean {
  return (stage === "company" || stage === "scout-task") && status === "idle";
}

export function nextOnboardingStage(
  stage: OnboardingV2Stage,
  outcome: { founderValid?: boolean } = {},
): OnboardingV2Stage {
  switch (stage) {
    case "founder":
      return outcome.founderValid ? "company" : "founder";
    case "company":
      return "scout-task";
    case "scout-task":
      return "entering";
    case "entering":
      return "entering";
  }
}

function v1DraftIsMigratable(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  // The delivery marker is the only state that cannot be regenerated: it
  // dedupes the first-task handoff. Everything else has safe defaults.
  return (
    candidate.version === 1 &&
    typeof candidate.firstTask === "object" &&
    candidate.firstTask !== null &&
    typeof (candidate.firstTask as Record<string, unknown>).deliveryMarker ===
      "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isKnownFirstTaskMode(
  value: unknown,
): value is OnboardingFirstTaskMode {
  return value === "suggestion" || value === "choice";
}

/** Unknown persisted intent fails closed into the choice-first handoff. */
function migrateUnknownV2Mode(value: unknown): OnboardingV2Draft | null {
  if (!isRecord(value) || value.version !== ONBOARDING_V2_VERSION) return null;
  const firstTask = value.firstTask;
  if (!isRecord(firstTask) || typeof firstTask.deliveryMarker !== "string") {
    return null;
  }
  const withoutMode = {
    ...value,
    firstTask: { ...firstTask, mode: undefined },
  };
  if (!isOnboardingV2Draft(withoutMode)) return null;
  const mode = firstTask.mode;
  return {
    ...withoutMode,
    firstTask: {
      ...withoutMode.firstTask,
      mode:
        mode === undefined
          ? "choice"
          : isKnownFirstTaskMode(mode)
            ? mode
            : "choice",
    },
  };
}

const V1_STAGE_FALLBACK: Record<string, OnboardingV2Stage> = {
  founder: "founder",
  website: "company",
  scan: "company",
  summary: "company",
  description: "company",
  "runtime-check": "scout-task",
  "runtime-ready": "scout-task",
  "agent-install": "scout-task",
  model: "scout-task",
  scout: "scout-task",
  "first-task": "scout-task",
  entering: "entering",
};

/**
 * Accept a persisted draft from any shipped version. V1 drafts (0.10.21)
 * keep their captured context and task; stages collapse onto the v2 machine
 * with the most advanced equivalent so nobody replays steps they finished.
 */
export function migrateOnboardingV2Draft(
  value: unknown,
): OnboardingV2Draft | null {
  const migratedV2 = migrateUnknownV2Mode(value);
  if (migratedV2) return migratedV2;
  if (isOnboardingV2Draft(value)) return value;
  if (!v1DraftIsMigratable(value)) return null;
  const base = createOnboardingV2Draft();
  const v1 = value as {
    stage?: unknown;
    founder?: Partial<OnboardingV2Draft["founder"]>;
    company?: Partial<OnboardingV2Draft["company"]>;
    runtime?: Partial<OnboardingV2Draft["runtime"]>;
    credits?: Partial<OnboardingV2Draft["credits"]>;
    firstTask?: Partial<OnboardingV2Draft["firstTask"]>;
  };
  const stage =
    typeof v1.stage === "string"
      ? (V1_STAGE_FALLBACK[v1.stage] ?? "company")
      : "company";
  return {
    version: ONBOARDING_V2_VERSION,
    stage,
    founder: { ...base.founder, ...v1.founder },
    company: { ...base.company, ...v1.company },
    runtime: { ...base.runtime, ...v1.runtime },
    credits: { ...base.credits, ...v1.credits },
    // V1 drafts intentionally keep the old content and completion path. Do
    // not inherit the choice-first default used by new v2 signups.
    firstTask: { ...base.firstTask, ...v1.firstTask, mode: undefined },
  };
}

export function isOnboardingV2Draft(
  value: unknown,
): value is OnboardingV2Draft {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OnboardingV2Draft>;
  return (
    candidate.version === ONBOARDING_V2_VERSION &&
    ONBOARDING_V2_STAGES.includes(candidate.stage as OnboardingV2Stage) &&
    typeof candidate.founder?.fullName === "string" &&
    typeof candidate.company?.summary === "string" &&
    typeof candidate.runtime?.model === "string" &&
    (candidate.credits?.balanceNanousd === null ||
      typeof candidate.credits?.balanceNanousd === "string") &&
    ["active", "depleted", "unavailable"].includes(
      candidate.credits?.status ?? "",
    ) &&
    typeof candidate.firstTask?.deliveryMarker === "string" &&
    (candidate.firstTask?.mode === undefined ||
      isKnownFirstTaskMode(candidate.firstTask.mode))
  );
}
