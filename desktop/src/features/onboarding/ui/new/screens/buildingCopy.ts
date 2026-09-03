// desktop/src/features/onboarding/ui/new/screens/buildingCopy.ts
import type { ScrapeFailureReason } from "../../../contracts";

/**
 * Every word the building screen says, in one place.
 *
 * It used to be three screens (probing, reading, description) and three copy
 * modules with three copy tests. The screens merged; the rules those tests
 * held did not change, so the copy and the tests moved here together.
 */

/** One line of the live list, before and after it finishes. */
export type WorkLineCopy = {
  id: WorkLineId;
  doing: string;
  done: string;
};

export type WorkLineId = "workspace" | "computer" | "website" | "draft";

/**
 * The lines, in the order they run.
 *
 * Two rules carried over from the probing screen and enforced below: the line
 * about the computer says plainly that the computer is being looked at,
 * because the cheerful alternative is a lie the product would have to keep;
 * and no line names a developer concept or guesses at the hardware.
 */
export const WORK_LINES: readonly WorkLineCopy[] = [
  {
    id: "workspace",
    doing: "Making your workspace",
    done: "Your workspace is ready",
  },
  {
    id: "computer",
    doing: "Looking at what is already on your computer",
    done: "Looked at what is already on your computer",
  },
  {
    id: "website",
    doing: "Reading your website",
    done: "Read your website",
  },
  {
    id: "draft",
    doing: "Writing down what you do",
    done: "Wrote down what you do",
  },
];

/** The lines this founder will see, which depends on having a website. */
export function workLines(hasWebsite: boolean): readonly WorkLineCopy[] {
  if (hasWebsite) return WORK_LINES;
  return WORK_LINES.filter(
    (line) => line.id !== "website" && line.id !== "draft",
  );
}

/**
 * Every failure gets the same plain sentence. A user whose site sits behind a
 * bot wall does not need to be taught what a bot wall is.
 */
const UNREACHABLE = "We couldn't reach that site.";

export const SCRAPE_FAILURE_COPY: Record<ScrapeFailureReason, string> = {
  unreachable: UNREACHABLE,
  blocked: UNREACHABLE,
  empty: UNREACHABLE,
  timeout: UNREACHABLE,
};

/** The screen's own headline, which never changes while the list runs. */
export const BUILDING_HEADLINE = {
  lead: "Building your ",
  emphasis: "workspace",
  tail: ".",
};

export function draftCopy(input: {
  hasWebsite: boolean;
  scrapeFailed: boolean;
}): { title: string; sub: string } {
  // Two separate reasons the generated text is absent: nothing was read, or
  // reading failed. Either way the app must not claim it found something.
  if (!input.hasWebsite) {
    return {
      title: "Tell us what you do.",
      sub: "A line or two is enough. Your agents work from this.",
    };
  }
  if (input.scrapeFailed) {
    return {
      title: "Tell us what you do.",
      sub: `${UNREACHABLE} Write a line or two about your business instead.`,
    };
  }
  return {
    title: "Here is what we found.",
    sub: "Change anything we got wrong. Your agents work from this.",
  };
}

/**
 * Sentences a founder with no website can tap instead of facing a blank box.
 *
 * Nothing was read, so there is nothing to show them, and "20 more characters"
 * under an empty box is a word count rather than a prompt. These are the shape
 * of the answer, in three different trades, so tapping one leaves something
 * true-shaped to edit rather than something to invent. The label beside them
 * says to change it, and they are never submitted for anyone: the box is
 * editable and this is what it starts from.
 */
export const DRAFT_OPENERS: readonly string[] = [
  "We repair and service cars for owners around Johannesburg.",
  "We deliver and install furniture for homes around Cape Town.",
  "We keep the books for small shops around Durban.",
];

export const DRAFT_OPENERS_LABEL = "Tap one and change it to your own words.";
