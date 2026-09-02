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
  /**
   * Catalog id, which is what installing, signing in and writing the config
   * all key off. The screen used to carry labels alone, which was enough
   * while it could only pick an already-ready runtime; now that it installs
   * and signs in, a label is not addressable.
   */
  id: string;
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
 * The brain the screen opens on: Colony Agent whenever it is listed.
 *
 * It used to be `installed[0]`, so a founder with Oh My Pi on their computer
 * opened on a row named "Oh My Pi" while the copy beside it said Colony runs
 * a brain for them. Detection order is not a recommendation, and the tool
 * names in that list mean nothing to the person this flow is written for.
 * Colony Agent is hosted, so it is ready on every computer and is the only
 * option that can be preselected without also being a guess. The other rows
 * stay selectable: this changes what is already chosen, not what is offered.
 */
export function preselectedBrain(
  brains: readonly BrainCandidate[],
  installed: readonly string[] = [],
): string {
  if (brains.some((brain) => brain.id === COLONY_AGENT_RUNTIME_ID)) {
    return COLONY_AGENT_RUNTIME_ID;
  }
  return installed[0] ?? COLONY_AGENT_RUNTIME_ID;
}

/**
 * The track a brain choice implies, which is not always the track probing
 * resolved.
 *
 * `resolveTrack` answers "what could this computer do" from detection alone,
 * and it runs before the founder has said anything. Once they pick, the pick
 * is the answer: choosing the hosted agent means Colony does the thinking and
 * credits pay for it, however many CLIs are installed beside it. Without this
 * a founder who kept the Colony Agent default on a machine with Claude Code
 * signed in reached a credits screen telling them their own tool covers the
 * thinking, which is the opposite of what they chose.
 */
export function trackForBrain(
  brain: string | null,
  installed: readonly string[] = [],
): OnboardingTrack {
  const chosen = brain?.trim();
  if (!chosen || chosen === COLONY_AGENT_RUNTIME_ID || chosen === "colony") {
    return "colony";
  }
  return installed.includes(chosen) ? "byo" : "colony";
}

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
  /**
   * Catalog ids of runtimes the user can actually use, for screen 5a. Ids
   * rather than labels because the screen now installs and signs in as well
   * as picking, and every one of those calls is keyed by id.
   */
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
    .map((runtime) => runtime.id);

  const readiness = resolveAgentReadiness(runtimes, config, "any");
  const colonyAgent = runtimes.find(
    (runtime) => runtime.id === COLONY_AGENT_RUNTIME_ID,
  );
  const track: OnboardingTrack =
    readiness.ready && readiness.reason === "cli" ? "byo" : "colony";

  return {
    track: installed.length ? track : "colony",
    installed,
    brains: brainsFromRuntimes(runtimes, colonyAgent?.label),
  };
}

/**
 * The brain list, derived from the runtime catalog alone.
 *
 * Split out of `resolveTrack` because the brain screen now installs and signs
 * in, so it has to recompute statuses as the catalog changes rather than
 * render the snapshot probing took. `resolveTrack` needs the agent config to
 * decide the track; this does not, so the screen can refresh without one.
 */
export function brainsFromRuntimes(
  runtimes: readonly AcpRuntimeCatalogEntry[],
  colonyAgentLabel?: string,
): BrainCandidate[] {
  const hosted: BrainCandidate[] = [
    {
      id: COLONY_AGENT_RUNTIME_ID,
      label:
        colonyAgentLabel ??
        runtimes.find((runtime) => runtime.id === COLONY_AGENT_RUNTIME_ID)
          ?.label ??
        COLONY_AGENT_LABEL,
      // Hosted: there is nothing to install and nothing to sign in to, so it
      // is the one option that is ready on every computer.
      status: "ready" as const,
    },
  ];
  const detected: BrainCandidate[] = runtimes
    .filter((runtime) => runtime.id !== COLONY_AGENT_RUNTIME_ID)
    .map((runtime) => {
      if (runtime.availability !== "available") {
        return {
          id: runtime.id,
          label: runtime.label,
          status: "not-installed" as const,
        };
      }
      const signedIn =
        runtime.authStatus.status === "logged_in" ||
        runtime.authStatus.status === "not_applicable";
      return {
        id: runtime.id,
        label: runtime.label,
        status: signedIn ? ("ready" as const) : ("needs-login" as const),
      };
    });

  return orderBrains([...hosted, ...detected]);
}
