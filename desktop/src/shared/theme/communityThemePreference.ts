import { normalizeRelayUrl } from "@/features/profile/lib/selfProfileStorage";
import { ACCENT_COLORS, defaultAppearanceTheme } from "./ThemeProvider";
import { SYNTAX_THEMES, type SyntaxThemeName } from "./theme-loader";
import {
  type WorkspaceGradientPattern,
  parseWorkspaceGradientPattern,
} from "./workspaceAppearance";

import {
  DEFAULT_CUSTOM_GRADIENT,
  parseCustomGradient,
  type CustomGradient,
} from "./customGradient";

/**
 * Bumped alongside the global accent key.
 *
 * Per-community preferences also store an accent, and they win over the global
 * one. Colony themes used to force neutral and persist it here too, so a v1
 * preference keeps the workspace greyscale even after the global key is
 * retired. Dropping v1 lets the brand default through; a preference saved from
 * here on is a real choice.
 */
const STORAGE_KEY_PREFIX = "buzz-community-theme.v2";
const OUTBOX_KEY_PREFIX = "buzz-community-theme-outbox.v1";
const MIGRATION_KEY_PREFIX = "buzz-community-theme-migrated.v1";

export type CommunityThemePreference = {
  version: 1;
  theme: SyntaxThemeName;
  accent: string;
  followSystem: boolean;
  gradientPattern: WorkspaceGradientPattern;
  customGradient?: CustomGradient;
};

export const DEFAULT_COMMUNITY_THEME: CommunityThemePreference = Object.freeze({
  version: 1,
  theme: "buzz",
  accent: "#895AF6",
  followSystem: true,
  gradientPattern: "soft-mesh",
});

const THEME_NAMES = new Set<string>(SYNTAX_THEMES);
const ACCENTS = new Set<string>(ACCENT_COLORS.map(({ value }) => value));

export function communityThemeStorageKey(
  pubkey: string,
  relayUrl: string,
): string {
  return `${STORAGE_KEY_PREFIX}:${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`;
}

export function communityThemeOutboxKey(
  pubkey: string,
  relayUrl: string,
): string {
  return `${OUTBOX_KEY_PREFIX}:${pubkey}:${encodeURIComponent(normalizeRelayUrl(relayUrl))}`;
}

export function parseCommunityThemePreference(
  value: unknown,
): CommunityThemePreference | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.theme !== "string" ||
    !THEME_NAMES.has(candidate.theme) ||
    typeof candidate.accent !== "string" ||
    !ACCENTS.has(candidate.accent) ||
    typeof candidate.followSystem !== "boolean" ||
    (candidate.customGradient !== undefined &&
      !parseCustomGradient(candidate.customGradient))
  ) {
    return null;
  }
  return {
    version: 1,
    theme: defaultAppearanceTheme(candidate.theme),
    accent: candidate.accent,
    followSystem: candidate.followSystem,
    gradientPattern: parseWorkspaceGradientPattern(candidate.gradientPattern),
    ...(candidate.customGradient === undefined
      ? {}
      : {
          customGradient:
            parseCustomGradient(candidate.customGradient) ??
            DEFAULT_CUSTOM_GRADIENT,
        }),
  };
}

export function readCommunityThemePreference(
  pubkey: string,
  relayUrl: string,
): CommunityThemePreference | null {
  try {
    const raw = window.localStorage.getItem(
      communityThemeStorageKey(pubkey, relayUrl),
    );
    return raw ? parseCommunityThemePreference(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function readCommunityThemeOutbox(
  pubkey: string,
  relayUrl: string,
): CommunityThemePreference | null {
  try {
    const raw = window.localStorage.getItem(
      communityThemeOutboxKey(pubkey, relayUrl),
    );
    return raw ? parseCommunityThemePreference(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeCommunityThemeOutbox(
  pubkey: string,
  relayUrl: string,
  preference: CommunityThemePreference,
): boolean {
  try {
    window.localStorage.setItem(
      communityThemeOutboxKey(pubkey, relayUrl),
      JSON.stringify(preference),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearCommunityThemeOutbox(
  pubkey: string,
  relayUrl: string,
  acknowledged: CommunityThemePreference,
): void {
  const pending = readCommunityThemeOutbox(pubkey, relayUrl);
  if (!pending || !sameCommunityThemePreference(pending, acknowledged)) return;
  try {
    window.localStorage.removeItem(communityThemeOutboxKey(pubkey, relayUrl));
  } catch {
    // A later retry can safely publish the same replaceable event again.
  }
}

export function hasMigratedCommunityTheme(pubkey: string): boolean {
  try {
    return (
      window.localStorage.getItem(`${MIGRATION_KEY_PREFIX}:${pubkey}`) ===
      "true"
    );
  } catch {
    return false;
  }
}

export function markCommunityThemeMigrated(pubkey: string): void {
  try {
    window.localStorage.setItem(`${MIGRATION_KEY_PREFIX}:${pubkey}`, "true");
  } catch {
    // The preference itself remains usable in memory when storage is full.
  }
}

export function writeCommunityThemePreference(
  pubkey: string,
  relayUrl: string,
  preference: CommunityThemePreference,
): boolean {
  try {
    window.localStorage.setItem(
      communityThemeStorageKey(pubkey, relayUrl),
      JSON.stringify(preference),
    );
    return true;
  } catch {
    return false;
  }
}

export function cacheAndApplyCommunityTheme(
  pubkey: string,
  relayUrl: string,
  preference: CommunityThemePreference,
  apply: (preference: CommunityThemePreference) => void,
): void {
  writeCommunityThemePreference(pubkey, relayUrl, preference);
  apply(preference);
}

export function communityThemeScopeFallback(
  migrated: boolean,
  inherited: CommunityThemePreference,
): CommunityThemePreference {
  return migrated ? DEFAULT_COMMUNITY_THEME : inherited;
}

export function sameCommunityThemePreference(
  left: CommunityThemePreference,
  right: CommunityThemePreference,
): boolean {
  const leftGradient = left.customGradient ?? DEFAULT_CUSTOM_GRADIENT;
  const rightGradient = right.customGradient ?? DEFAULT_CUSTOM_GRADIENT;
  return (
    defaultAppearanceTheme(left.theme) ===
      defaultAppearanceTheme(right.theme) &&
    left.accent === right.accent &&
    left.followSystem === right.followSystem &&
    parseWorkspaceGradientPattern(left.gradientPattern) ===
      parseWorkspaceGradientPattern(right.gradientPattern) &&
    leftGradient.enabled === rightGradient.enabled &&
    leftGradient.color1 === rightGradient.color1 &&
    leftGradient.color2 === rightGradient.color2
  );
}

export function communityThemeApplyExpectation(
  preference: CommunityThemePreference,
  current: CommunityThemePreference,
  preserveNoop = false,
): CommunityThemePreference | null {
  return preserveNoop || !sameCommunityThemePreference(preference, current)
    ? preference
    : null;
}

/**
 * Decide whether the current context value is safe to persist for this scope.
 * Applying a scoped preference updates the outer ThemeProvider asynchronously,
 * so renders that still expose the previous scope must be deferred.
 */
export function communityThemePersistenceAction(
  expectedApplied: CommunityThemePreference | null,
  current: CommunityThemePreference,
): "persist" | "defer" | "acknowledge" {
  if (!expectedApplied) return "persist";
  return sameCommunityThemePreference(expectedApplied, current)
    ? "acknowledge"
    : "defer";
}
