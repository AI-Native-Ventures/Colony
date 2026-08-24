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

/**
 * What Colony runs for someone with nothing installed.
 *
 * It is hosted, so it is always available and never needs signing in; the
 * catalog carries it as a runtime like any other, which is why it has to be
 * named here rather than detected. Leaving it out of the list was the reason
 * a clean computer could reach this screen with no usable option on it.
 */
const COLONY_AGENT_RUNTIME_ID = "buzz-agent";
const COLONY_AGENT_LABEL = "Colony Agent";

/**
 * Ready first, then what needs signing in, then what is not here at all.
 *
 * The catalog's own order is alphabetical-ish and mixes the three together,
 * so a list of a dozen tools buried the two someone could actually use among
 * the ones they cannot. Ordering is stable within each group, so the list
 * does not reshuffle between renders.
 */
const STATUS_RANK: Record<BrainStatus, number> = {
  ready: 0,
  "needs-login": 1,
  "not-installed": 2,
};

export function orderBrains(
  brains: readonly BrainCandidate[],
): BrainCandidate[] {
  return [...brains].sort(
    (left, right) => STATUS_RANK[left.status] - STATUS_RANK[right.status],
  );
}

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
  const colonyAgent = runtimes.find(
    (runtime) => runtime.id === COLONY_AGENT_RUNTIME_ID,
  );
  const hosted: BrainCandidate[] = [
    {
      label: colonyAgent?.label ?? COLONY_AGENT_LABEL,
      // Hosted: there is nothing to install and nothing to sign in to, so it
      // is the one option that is ready on every computer.
      status: "ready" as const,
    },
  ];
  const detected: BrainCandidate[] = runtimes
    .filter((runtime) => runtime.id !== COLONY_AGENT_RUNTIME_ID)
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

  return {
    track: installed.length ? track : "colony",
    installed,
    brains: orderBrains([...hosted, ...detected]),
  };
}
