import type { ActionItem } from "../contracts";
import { formatInitiativeLabel } from "./askContextLine";

/**
 * The `no-initiative` sentinel the relay requires on every ask (see
 * OpenAsk.initiativeId's doc comment): chat-derived work with nothing to
 * name. Also the bucket for every non-ask item kind, which has no
 * initiative concept at all -- a block, reminder, workflow approval, or
 * thread ping never carries an initiative tag.
 */
export const NO_INITIATIVE = "no-initiative";

/** Which initiative bucket an item falls into for chip filtering. */
export function itemInitiativeBucket(item: ActionItem): string {
  if (item.source.kind !== "ask") return NO_INITIATIVE;
  const id = item.source.ask.initiativeId;
  return id && id !== NO_INITIATIVE ? id : NO_INITIATIVE;
}

export type InitiativeChip = {
  id: string;
  label: string;
  count: number;
};

/**
 * Chips derived from the items actually present (spec: "derived from the
 * items present"), never a fixed list. Returns an empty array when fewer
 * than two buckets exist -- a chip row offering only "All" alongside a
 * single option filters nothing, so it does not render at all (same
 * judgement as the epic's "grouping is pointless at 5 items" rule, applied
 * to chips). "No initiative" always sorts last, matching the wireframe;
 * named initiatives sort alphabetically by their raw id before that.
 */
export function selectInitiativeChips(
  items: readonly ActionItem[],
): InitiativeChip[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const bucket = itemInitiativeBucket(item);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  if (counts.size < 2) return [];

  const named = [...counts.entries()]
    .filter(([id]) => id !== NO_INITIATIVE)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, count]) => ({ id, label: formatInitiativeLabel(id), count }));

  const noInitiativeCount = counts.get(NO_INITIATIVE);
  if (noInitiativeCount === undefined) return named;
  return [
    ...named,
    { id: NO_INITIATIVE, label: "No initiative", count: noInitiativeCount },
  ];
}

/**
 * Chips filter, they never regroup (spec, explicit): this only narrows the
 * list the caller already has, it never changes ranking or membership
 * beyond the one bucket selected. `null` (the "All" chip) returns every
 * item unchanged.
 */
export function filterByInitiative(
  items: readonly ActionItem[],
  initiative: string | null,
): ActionItem[] {
  if (!initiative) return [...items];
  return items.filter((item) => itemInitiativeBucket(item) === initiative);
}
