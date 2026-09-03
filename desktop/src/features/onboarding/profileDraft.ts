// desktop/src/features/onboarding/profileDraft.ts
import type { Profile } from "@/shared/api/types";

export type ProfileDraftValues = {
  avatarUrl: string;
  displayName: string;
};

/**
 * A relay that has no name for someone answers with their npub. Showing that
 * back to them as "their name" reads as a name they chose, so it is treated
 * as no name at all.
 */
export function isFallbackDisplayName(value?: string | null): boolean {
  const normalizedValue = value?.trim().toLowerCase() ?? "";
  return (
    normalizedValue.startsWith("npub1") ||
    normalizedValue.startsWith("nostr:npub1")
  );
}

export function sanitizeDisplayName(value?: string | null): string {
  const trimmedValue = value?.trim() ?? "";
  return isFallbackDisplayName(trimmedValue) ? "" : trimmedValue;
}

export function resolveSavedProfile(
  profile: Profile | null | undefined,
): ProfileDraftValues {
  return {
    avatarUrl: profile?.avatarUrl ?? "",
    displayName: sanitizeDisplayName(profile?.displayName),
  };
}

/**
 * What actually needs writing. An unchanged field is left out rather than
 * rewritten, so a save that changes nothing sends nothing and cannot fail.
 */
export function createProfileUpdatePayload({
  draftProfile,
  savedProfile,
}: {
  draftProfile: ProfileDraftValues;
  savedProfile: ProfileDraftValues;
}): { avatarUrl?: string; displayName?: string } {
  const nextDisplayName = draftProfile.displayName.trim();
  const nextAvatarUrl = draftProfile.avatarUrl.trim();
  const updatePayload: {
    avatarUrl?: string;
    displayName?: string;
  } = {};

  if (
    nextDisplayName.length > 0 &&
    nextDisplayName !== savedProfile.displayName
  ) {
    updatePayload.displayName = nextDisplayName;
  }

  if (nextAvatarUrl.length > 0 && nextAvatarUrl !== savedProfile.avatarUrl) {
    updatePayload.avatarUrl = nextAvatarUrl;
  }

  return updatePayload;
}
