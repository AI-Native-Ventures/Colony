/**
 * How a message's Discovery tiles are laid out.
 *
 * One entity gets the full width, because a single tile is the subject of the
 * message rather than a list item. Two through four pair up into a two-column
 * grid. Beyond that only the first four render, followed by a control that
 * opens the full set in Discovery: a message that mentions thirty leads must
 * not push the rest of the timeline off the screen.
 */

export const DISCOVERY_TILE_GRID_LIMIT = 4;

export type DiscoveryTileLayout = {
  /** "wide" is one full-width tile; "grid" is the two-column grid. */
  variant: "wide" | "grid";
  /** How many tiles render. */
  visibleCount: number;
  /** How many are held behind "Show all N"; zero when everything renders. */
  hiddenCount: number;
};

export function discoveryTileLayout(count: number): DiscoveryTileLayout {
  const total = Math.max(0, Math.trunc(count));
  if (total <= 1) {
    return { variant: "wide", visibleCount: total, hiddenCount: 0 };
  }
  if (total <= DISCOVERY_TILE_GRID_LIMIT) {
    return { variant: "grid", visibleCount: total, hiddenCount: 0 };
  }
  return {
    variant: "grid",
    visibleCount: DISCOVERY_TILE_GRID_LIMIT,
    hiddenCount: total - DISCOVERY_TILE_GRID_LIMIT,
  };
}
