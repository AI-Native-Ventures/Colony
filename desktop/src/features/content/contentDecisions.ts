/**
 * Signing the owner's decision about one post.
 *
 * This is the only write the desktop makes into the content calendar. The
 * agent writes campaigns, posts, and style; the owner writes approvals and
 * change requests, and they are separate events so that the author of a card
 * cannot also author its sign-off.
 *
 * Two things travel on the decision that look like duplication and are not:
 *
 * - **The image hash.** A post is a replaceable event, so its contents can
 *   change after approval without anything moving. Naming the exact bytes is
 *   what lets a reader tell "approved" from "approved, then re-rendered".
 * - **The gate verdict.** Recomputed here from the post's own gate statuses
 *   rather than copied from the report's summary. The relay refuses an
 *   approval whose verdict is `fail`; computing it locally means this client
 *   never asks it to.
 */

import {
  KIND_CONTENT_DECISION,
  KIND_CONTENT_POST,
} from "@/shared/constants/kinds";

import type { ContentPost, CorrectionBin, GateVerdict } from "./contracts";
import {
  postVerdict as contractPostVerdict,
  postCoordinate,
  slidesDigest,
} from "./contracts";

/** Pinned schema for the decision record; mirrors `buzz-core`. */
export const SCHEMA_CONTENT_DECISION = "colony/content-decision/v1";

export type DecisionInput = {
  post: ContentPost;
  decision: "approve" | "change";
  note?: string | null;
  correction?: { bin: CorrectionBin; text: string } | null;
};

export type SignedEventInput = {
  kind: number;
  content: string;
  tags: string[][];
};

export type DecisionRefusal = {
  ok: false;
  reason: string;
};

export type DecisionDraft = {
  ok: true;
  event: SignedEventInput;
  verdict: GateVerdict;
};

/**
 * The verdict a post's own gates add up to.
 *
 * A post with no report has had nothing measured, which is exactly what
 * `incomplete` means. Reporting anything else would let an unrendered card be
 * approved as though its gates had run.
 */
export function postVerdict(post: ContentPost): GateVerdict {
  return contractPostVerdict(post.gateReports) ?? "incomplete";
}

/**
 * Build the event for one decision, or refuse and say why.
 *
 * Refusals here are the same ones the relay makes, reached before a round
 * trip so the button can be disabled with a reason instead of the person
 * finding out after clicking.
 */
export function buildDecisionEvent(
  input: DecisionInput,
): DecisionDraft | DecisionRefusal {
  const verdict = postVerdict(input.post);
  const note = input.note?.trim() ?? "";
  const correction = input.correction;

  if (input.decision === "approve") {
    if (verdict === "fail") {
      return {
        ok: false,
        reason:
          "This card failed a check. Approving it is refused until the check passes or the card is re-rendered.",
      };
    }
    if (input.post.images.length === 0) {
      return {
        ok: false,
        reason:
          "This card has not been rendered yet, so there is nothing to approve.",
      };
    }
  }

  if (input.decision === "change" && note.length === 0 && !correction) {
    return {
      ok: false,
      reason:
        "Say what you want changed. A change request with no note is not actionable.",
    };
  }

  const target: Record<string, unknown> = { verdict };
  if (input.post.images.length > 0) {
    target.image_sha256 = slidesDigest(input.post.images);
  }

  const content: Record<string, unknown> = {
    decision: input.decision,
    schema: SCHEMA_CONTENT_DECISION,
    target,
  };
  if (note.length > 0) {
    content.note = note;
  }
  if (correction) {
    content.correction = { bin: correction.bin, text: correction.text };
  }

  return {
    event: {
      content: JSON.stringify(content),
      kind: KIND_CONTENT_DECISION,
      tags: [["a", postCoordinate(input.post, KIND_CONTENT_POST)]],
    },
    ok: true,
    verdict,
  };
}
