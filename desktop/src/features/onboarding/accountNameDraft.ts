import type { AnswerStorage } from "./flow/persistence";
import type { OnboardingFounder } from "./flow/steps";
import { sanitizeDisplayName } from "./profileDraft";

const ACCOUNT_NAME_KEY = "colony.onboarding.account-name.v1";

/** Keep the public name across signup/recovery before an identity is available. */
export function saveAccountNameDraft(
  storage: AnswerStorage,
  email: string,
  fullName: string,
): void {
  if (
    storage.set(
      ACCOUNT_NAME_KEY,
      JSON.stringify({
        email: email.trim().toLowerCase(),
        fullName: sanitizeDisplayName(fullName),
      }),
    ) === false
  ) {
    throw new Error("Could not save your name on this device. Try again.");
  }
}

/** A pending signup may restore only the name entered for its own email. */
export function readAccountNameDraft(
  storage: AnswerStorage,
  email: string,
): string {
  try {
    const raw = storage.get(ACCOUNT_NAME_KEY);
    if (!raw) return "";
    const draft: unknown = JSON.parse(raw);
    if (!draft || typeof draft !== "object") return "";
    const value = draft as Record<string, unknown>;
    return value.email === email.trim().toLowerCase() &&
      typeof value.fullName === "string"
      ? sanitizeDisplayName(value.fullName)
      : "";
  } catch {
    return "";
  }
}

/** Remove only the signup name that the caller has durably handed off. */
export function clearAccountNameDraft(
  storage: AnswerStorage,
  email: string,
): void {
  if (readAccountNameDraft(storage, email)) storage.remove(ACCOUNT_NAME_KEY);
}

/** Merge a collected name without erasing older optional founder details. */
export function founderWithName(
  founder: OnboardingFounder | null,
  fullName: string,
): OnboardingFounder | null {
  const name = sanitizeDisplayName(fullName);
  if (!name) return founder;
  return {
    city: "",
    country: "",
    gender: null,
    selfDescribedGender: "",
    avatarUrl: "",
    ...founder,
    fullName: name,
  };
}
