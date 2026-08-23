import { resolveAgentReadiness } from "@/features/onboarding/ui/agentReadiness";
import type {
  AcpRuntimeCatalogEntry,
  GlobalAgentConfig,
} from "@/shared/api/types";
import type { OnboardingTrack } from "./steps";

/**
 * Whole-screen budget for detection. A binary that never answers costs the
 * flow this much and no more; anything still silent is treated as absent.
 */
export const PROBE_BUDGET_MS = 8000;

/** How a brain stands on this computer, for screen 5a. */
export type BrainStatus = "ready" | "needs-login" | "not-installed";

export type BrainCandidate = {
  label: string;
  status: BrainStatus;
};

export type TrackResult = {
  track: OnboardingTrack;
  /** Labels of runtimes the user can actually use, for screen 5a. */
  installed: string[];
  /**
   * Every brain Colony knows about, ready or not.
   *
   * Screen 5a lists all of them. Listing only what was found turns a picker
   * into a single row, or into nothing at all for someone with a clean
   * computer, and neither reads as a choice. Showing the whole set with an
   * honest status is what makes it one.
   */
  brains: BrainCandidate[];
};

export function resolveTrack(
  runtimes: readonly AcpRuntimeCatalogEntry[],
  config: GlobalAgentConfig,
): TrackResult {
  const installed = runtimes
    .filter(
      (runtime) =>
        runtime.id !== "buzz-agent" &&
        runtime.availability === "available" &&
        (runtime.authStatus.status === "logged_in" ||
          runtime.authStatus.status === "not_applicable"),
    )
    .map((runtime) => runtime.label);

  const readiness = resolveAgentReadiness(runtimes, config, "any");
  const brains: BrainCandidate[] = runtimes
    .filter((runtime) => runtime.id !== "buzz-agent")
    .map((runtime) => {
      if (runtime.availability !== "available") {
        return { label: runtime.label, status: "not-installed" as const };
      }
      const signedIn =
        runtime.authStatus.status === "logged_in" ||
        runtime.authStatus.status === "not_applicable";
      return {
        label: runtime.label,
        status: signedIn ? ("ready" as const) : ("needs-login" as const),
      };
    });

  const track: OnboardingTrack =
    readiness.ready && readiness.reason === "cli" ? "byo" : "colony";

  return { track: installed.length ? track : "colony", installed, brains };
}
