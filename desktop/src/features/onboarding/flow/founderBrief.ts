// desktop/src/features/onboarding/flow/founderBrief.ts
import {
  type OnboardingV2Draft,
  createOnboardingV2Draft,
} from "../onboardingV2";
import type { OnboardingAnswers } from "./steps";

/**
 * Carry this flow's answers into the draft Scout's opening brief is built
 * from.
 *
 * The previous first-run flow collected the founder and company details and
 * left them on the community-onboarding transaction; the delivery path reads
 * that draft after the community exists and sends the brief as the first
 * message. Replacing the flow without this bridge would have left the draft
 * empty, so onboarding would still look finished while every agent started
 * knowing nothing about the company. Nothing about delivery changes: it still
 * reads the same field on the same transaction.
 */
export function draftFromAnswers(
  answers: OnboardingAnswers,
): OnboardingV2Draft {
  const base = createOnboardingV2Draft();
  const founder = answers.founder;
  const website = answers.hasWebsite ? (answers.website ?? "") : "";
  return {
    ...base,
    // The flow that owned these stages is gone; the draft exists now only as
    // the brief's payload, so it starts at the end rather than at "founder".
    stage: "scout-task",
    founder: {
      fullName: founder?.fullName ?? "",
      country: founder?.country ?? "",
      city: founder?.city ?? "",
      gender: founder?.gender ?? null,
      selfDescribedGender: founder?.selfDescribedGender ?? "",
    },
    company: {
      ...base.company,
      website,
      hasWebsite: answers.hasWebsite ?? false,
      canonicalUrl: website,
      summary: answers.description ?? "",
      scanStatus: answers.description ? "success" : "idle",
    },
    firstTask: {
      ...base.firstTask,
      // The brief itself is the first task now. The flow no longer asks for
      // one, and an empty content field would skip delivery entirely.
      content: firstTaskFor(answers),
    },
  };
}

/**
 * What Scout is asked to do first.
 *
 * Kept deliberately small and concrete: the company summary is already in the
 * brief above it, so this is the instruction, not a restatement.
 */
export function firstTaskFor(answers: OnboardingAnswers): string {
  const company = answers.company?.trim();
  return company
    ? `Get to know ${company} and tell me what you would work on first.`
    : "Get to know this company and tell me what you would work on first.";
}
