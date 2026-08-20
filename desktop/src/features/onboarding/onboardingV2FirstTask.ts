import type { OnboardingV2Draft } from "./onboardingV2";

export function onboardingFirstTaskMarker(draft: OnboardingV2Draft): string {
  return `colony-onboarding-v2:first-task:${draft.firstTask.deliveryMarker}`;
}

export function buildOnboardingFirstTaskMessage(
  draft: OnboardingV2Draft,
): string {
  const founder = draft.founder;
  const gender =
    founder.gender === "self-describe"
      ? founder.selfDescribedGender.trim()
      : founder.gender && founder.gender !== "prefer-not-to-say"
        ? founder.gender
        : "";
  const details = [
    `Founder: ${founder.fullName.trim()}`,
    `Location: ${founder.city.trim()}, ${founder.country.trim()}`,
    gender ? `Gender: ${gender}` : "",
    draft.company.hasWebsite && draft.company.canonicalUrl
      ? `Website: ${draft.company.canonicalUrl}`
      : "",
  ].filter(Boolean);

  return [
    "Scout, here is the company context I confirmed during onboarding.",
    details.join("\n"),
    `Business:\n${draft.company.summary.trim()}`,
    `First task:\n${draft.firstTask.content.trim()}`,
  ].join("\n\n");
}
