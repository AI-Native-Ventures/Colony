export const ONBOARDING_V2_VERSION = 1 as const;

export const FOUNDER_GENDERS = [
  "woman",
  "man",
  "non-binary",
  "self-describe",
  "prefer-not-to-say",
] as const;

export type FounderGender = (typeof FOUNDER_GENDERS)[number];

export const ONBOARDING_V2_STAGES = [
  "founder",
  "website",
  "scan",
  "summary",
  "description",
  "runtime-check",
  "runtime-ready",
  "agent-install",
  "payment-method",
  "credits",
  "model",
  "scout",
  "first-task",
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
  firstTask: {
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
    firstTask: {
      content: "",
      deliveryMarker: crypto.randomUUID(),
      deliveredEventId: null,
    },
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

export function shouldStartWebsiteScan(
  stage: OnboardingV2Stage,
  status: OnboardingV2Draft["company"]["scanStatus"],
): boolean {
  return stage === "scan" && status === "idle";
}

export function nextOnboardingStage(
  stage: OnboardingV2Stage,
  outcome: {
    founderValid?: boolean;
    hasWebsite?: boolean;
    scanStatus?: OnboardingV2Draft["company"]["scanStatus"];
    runtimeRoute?: OnboardingV2Draft["runtime"]["route"];
    creditsReady?: boolean;
  } = {},
): OnboardingV2Stage {
  switch (stage) {
    case "founder":
      return outcome.founderValid ? "website" : "founder";
    case "website":
      return outcome.hasWebsite === false ? "description" : "scan";
    case "scan":
      return outcome.scanStatus === "success" ? "summary" : "description";
    case "summary":
    case "description":
      return "runtime-check";
    case "runtime-check":
      return outcome.runtimeRoute === "cli" ? "runtime-ready" : "agent-install";
    case "runtime-ready":
      return "scout";
    case "agent-install":
      return "payment-method";
    case "payment-method":
      return "credits";
    case "credits":
      return outcome.creditsReady ? "model" : "credits";
    case "model":
      return "scout";
    case "scout":
      return "first-task";
    case "first-task":
      return "entering";
    case "entering":
      return "entering";
  }
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
    typeof candidate.firstTask?.deliveryMarker === "string"
  );
}
