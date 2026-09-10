/** The windows the communication graph's chip offers. */
export type CommGraphWindowId = "30m" | "2h" | "today";

export const COMM_GRAPH_WINDOWS: ReadonlyArray<{
  id: CommGraphWindowId;
  label: string;
}> = [
  { id: "30m", label: "30 min" },
  { id: "2h", label: "2 h" },
  { id: "today", label: "Today" },
];

/**
 * How far back a window reaches from `now`, in milliseconds.
 *
 * "Today" is local midnight rather than a fixed span, so the graph matches what
 * the owner means by today wherever they are and whenever they look.
 */
export function commGraphWindowMs(
  windowId: CommGraphWindowId,
  now: number,
): number {
  if (windowId === "30m") return 30 * 60 * 1_000;
  if (windowId === "2h") return 2 * 60 * 60 * 1_000;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return Math.max(0, now - midnight.getTime());
}
