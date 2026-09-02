/**
 * The `/work` search contract.
 *
 * `view` names the tab: Board, Tasks, My queue, Initiatives. `list` is the
 * default and is also a value the URL may carry, so a tab bar can address
 * every pane by name instead of one pane being "the absence of a param".
 */

export const WORK_VIEWS = ["list", "board", "queue", "initiatives"] as const;
export type WorkView = (typeof WORK_VIEWS)[number];

export type WorkRouteSearch = {
  view?: WorkView;
  /** The initiative the board is scoped to. Only the board reads it. */
  initiativeId?: string;
};

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
export function validateWorkSearch(
  search: Record<string, unknown>,
): WorkRouteSearch {
  return {
    initiativeId: nonEmptyString(search.initiativeId),
    view: enumValue(search.view, WORK_VIEWS),
  };
}

/**
 * The tab a search state selects.
 *
 * Kept separate from the validator so a bare `/work` (no param at all, which
 * is what every existing link produces) still lands on the same pane an
 * explicit `?view=list` does.
 */
export function workView(search: WorkRouteSearch): WorkView {
  return search.view ?? "list";
}
