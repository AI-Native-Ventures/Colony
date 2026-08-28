/**
 * Turning a post plus its decisions into the one chip a day card shows.
 *
 * Pure and separate from the components because this is the screen's only real
 * judgement, and it is the thing most worth getting wrong quietly: a card that
 * reads "approved" when its claims were never checked, or when its image
 * changed after sign-off, is exactly the failure the whole feature exists to
 * prevent.
 *
 * Two rules drive every case below:
 *
 * 1. **A skipped gate is not a passed gate.** `incomplete` gets its own tone
 *    and its own word, never folded into "checked".
 * 2. **An approval covers bytes, not a name.** If the image no longer hashes
 *    to what was signed off, the card is not approved any more.
 */

import type { ContentDecision, ContentPost, GateVerdict } from "./contracts";
import {
  approvalState,
  missingGates,
  postVerdict as contractPostVerdict,
} from "./contracts";

export type ChipTone = "neutral" | "good" | "warn" | "bad";

export type PostChip = {
  label: string;
  tone: ChipTone;
  /** One sentence a person can act on, shown as the chip's title. */
  detail: string;
};

/** The decisions that point at one post. */
export function decisionsForPost(
  post: ContentPost,
  decisions: ContentDecision[],
  postKind: number,
): ContentDecision[] {
  const coordinate = `${postKind}:${post.author}:${post.address}`;
  return decisions.filter((decision) => decision.coordinate === coordinate);
}

/** The verdict a post's own gates add up to, or null when nothing ran. */
export function postVerdict(post: ContentPost): GateVerdict | null {
  return contractPostVerdict(post.gateReports);
}

/**
 * The single chip for a day card.
 *
 * Order matters: a failing check outranks an approval, because a card can be
 * approved and then re-rendered into a failing state, and the person scanning
 * the week needs to see the failure rather than the stale blessing.
 */
export function postChip(
  post: ContentPost,
  decisions: ContentDecision[],
): PostChip {
  const verdict = postVerdict(post);
  const state = approvalState(post, decisions);

  if (verdict === "fail") {
    const failed =
      post.gateReports
        .flatMap((report) => report.gates)
        .find((gate) => gate.status === "fail")?.id ?? "a check";
    return {
      detail: `The ${failed} check failed. This card cannot be approved until it passes.`,
      label: "Check failed",
      tone: "bad",
    };
  }

  if (state === "changed-since-approval") {
    return {
      detail:
        "This card was approved, then re-rendered. The approval covered different bytes, so it no longer applies.",
      label: "Changed since approval",
      tone: "warn",
    };
  }

  if (state === "changes-requested") {
    return {
      detail: "Sent back with a note. Waiting on a new render.",
      label: "Changes asked",
      tone: "warn",
    };
  }

  if (state === "approved") {
    return verdict === "incomplete"
      ? {
          detail:
            "Approved with a check that never ran. You took responsibility for what it would have checked.",
          label: "Approved, not fully checked",
          tone: "warn",
        }
      : {
          detail: "Approved, and every check passed on these exact bytes.",
          label: "Approved",
          tone: "good",
        };
  }

  if (post.status === "draft") {
    return {
      detail:
        post.images.length > 0
          ? "Rendered but not offered for review yet."
          : "Planned. Nothing rendered yet.",
      label: post.images.length > 0 ? "Draft" : "Planned",
      tone: "neutral",
    };
  }

  if (verdict === "incomplete") {
    const skipped = post.gateReports
      .flatMap((report) => report.gates)
      .filter((gate) => gate.status === "skip")
      .map((gate) => gate.id);
    return {
      detail:
        skipped.length > 0
          ? `Ready for you, but ${skipped.join(" and ")} never ran. Nothing checked those.`
          : "Ready for you, with a check that never ran.",
      label: "Ready, not fully checked",
      tone: "warn",
    };
  }

  return {
    detail: "Ready for you, and every check passed.",
    label: "Ready for you",
    tone: "good",
  };
}

/**
 * A short line naming what nothing has verified about this card.
 *
 * Returns null when there is nothing to say. Kept separate from the chip
 * because the chip has room for a word and the detail panel has room for a
 * sentence, and a person deciding whether to publish deserves the sentence.
 */
export function unverifiedSummary(post: ContentPost): string | null {
  // A card nobody has drawn has no gates missing, it has no gates. Listing all
  // six as "not reported" read as six failures on a post whose only state is
  // that it is still a plan, and the checks panel says the same thing one line
  // below. Absence is a state with a name here, but only once there was
  // something to measure.
  if (post.gateReports.length === 0) {
    return null;
  }
  const missing = missingGates(post.gateReports);
  if (missing.length > 0) {
    return `Not reported at all: ${missing.join(", ")}.`;
  }
  const skipped = post.gateReports
    .flatMap((report) => report.gates)
    .filter((gate) => gate.status === "skip")
    .map((gate) => gate.id);
  if (skipped.length > 0) {
    return `Reported as not run: ${skipped.join(", ")}.`;
  }
  const unsourced = post.claims.filter((claim) => !claim.source);
  if (unsourced.length > 0) {
    return `${unsourced.length} claim${unsourced.length === 1 ? "" : "s"} with no source.`;
  }
  return null;
}
