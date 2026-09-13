// desktop/src/features/onboarding/flow/founderBrief.ts
import {
  type OnboardingV2Draft,
  createOnboardingV2Draft,
} from "../onboardingV2";
import type { OnboardingAnswers } from "./steps";
import { firstJobStarters } from "../firstJobStarters";

/** Carry confirmed answers into the choice-first Welcome root; no work starts here. */
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
      name: answers.company?.trim() || "Your business",
      website,
      hasWebsite: answers.hasWebsite ?? false,
      canonicalUrl: website,
      summary: answers.description ?? "",
      scanStatus: answers.description ? "success" : "idle",
    },
    firstTask: {
      ...base.firstTask,
      // Signup now opens Scout's choice-first conversation. Keep the marker
      // for durable resume, but do not carry a social starter task into it.
      mode: "choice",
      deliveryMarker: answers.firstTaskMarker ?? base.firstTask.deliveryMarker,
      content: "",
    },
  };
}

/** A concrete, reviewable starting suggestion, not an invented owner instruction. */
export function firstTaskFor(answers: OnboardingAnswers): string {
  return firstJobStarters(answers.company ?? "")[0].brief;
}
