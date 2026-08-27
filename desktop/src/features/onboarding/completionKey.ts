// desktop/src/features/onboarding/completionKey.ts

/**
 * The app-level first-run gate key. Lives in its own module so relay-free
 * code (the fresh-founder check runs before any community is applied) can
 * read it without importing the React hooks graph.
 */
export const ONBOARDING_COMPLETION_STORAGE_KEY = "buzz-onboarding-complete.v1";

export function onboardingCompletionStorageKey(pubkey: string): string {
  return `${ONBOARDING_COMPLETION_STORAGE_KEY}:${pubkey}`;
}
