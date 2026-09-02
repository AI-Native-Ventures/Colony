import {
  ACTION_CENTER_FILTERS,
  ACTION_CENTER_STATES,
  type ActionCenterFilter,
  type ActionCenterStateFilter,
} from "@/features/action-center/contracts";

/** The two panes the Inbox route can show. */
export const HOME_SURFACES = ["inbox", "actions"] as const;

/** Which pane of the Inbox is on screen. */
export type HomeSurface = (typeof HOME_SURFACES)[number];

/**
 * Search state for `/`.
 *
 * The Inbox owns `item` (the selected inbox row). The Actions pane, folded in
 * from the standalone Action Center route, owns `action` (its selected queue
 * item) alongside `filter`, `state`, and `initiative`. The two selections are
 * deliberately separate params so switching tabs does not carry one pane's row
 * id into the other, where it would resolve to nothing.
 */
export type HomeRouteSearch = {
  action?: string;
  filter?: ActionCenterFilter;
  initiative?: string;
  item?: string;
  profile?: string;
  profileTab?: string;
  profileView?: string;
  state?: ActionCenterStateFilter;
  view?: HomeSurface;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : undefined;
}

/** Validate and narrow untrusted URL search state at the router boundary. */
export function validateHomeSearch(
  search: Record<string, unknown>,
): HomeRouteSearch {
  return {
    action: nonEmptyString(search.action),
    filter: enumValue<ActionCenterFilter>(search.filter, ACTION_CENTER_FILTERS),
    // No fixed vocabulary to validate against, unlike `filter`/`state` --
    // initiative ids are whatever agents wrote on the `initiative` tag, so
    // this only rejects the shapes that can never be a real id (non-string,
    // empty/whitespace-only).
    initiative: nonEmptyString(search.initiative),
    item: nonEmptyString(search.item),
    profile: nonEmptyString(search.profile),
    profileTab: nonEmptyString(search.profileTab),
    profileView: nonEmptyString(search.profileView),
    state: enumValue<ActionCenterStateFilter>(
      search.state,
      ACTION_CENTER_STATES,
    ),
    view: enumValue<HomeSurface>(search.view, HOME_SURFACES),
  };
}

/** The pane to render, defaulting to the Inbox. */
export function homeSurface(search: HomeRouteSearch): HomeSurface {
  return search.view ?? "inbox";
}
