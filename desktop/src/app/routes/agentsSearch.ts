import {
  parseProfilePanelTab,
  parseProfilePanelView,
  type ProfilePanelTab,
  type ProfilePanelView,
} from "@/features/profile/ui/UserProfilePanelUtils";

/** Sections addressable inside the Agents view via the `section` search param. */
export type AgentsSection = "people";

export type AgentsRouteSearch = {
  profile?: string;
  profilePersona?: string;
  profileTab?: ProfilePanelTab;
  profileView?: ProfilePanelView;
  section?: AgentsSection;
};

const AGENTS_SECTIONS: readonly AgentsSection[] = ["people"];

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
): T | undefined {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : undefined;
}

/** Validate and narrow untrusted URL search state at the router boundary. */
export function validateAgentsSearch(
  search: Record<string, unknown>,
): AgentsRouteSearch {
  return {
    profile: nonEmptyString(search.profile),
    profilePersona: nonEmptyString(search.profilePersona),
    profileTab: parseProfilePanelTab(search.profileTab) ?? undefined,
    profileView: parseProfilePanelView(search.profileView) ?? undefined,
    section: enumValue(search.section, AGENTS_SECTIONS),
  };
}
