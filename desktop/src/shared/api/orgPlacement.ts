import { invokeTauri } from "./tauri";

/**
 * Persist the rank and reporting line the owner just published.
 *
 * The device rebuilds an agent's kind-30177 head from its local record on
 * every rename, parallelism change, persona relink, and restart. A placement
 * that only lives on the relay is overwritten by the next rebuild, which is
 * why ranks kept resetting to team lead and managers to unassigned. Writing
 * it into the record right after the publish is what makes it stick.
 *
 * `manager: null` clears the reporting line on purpose: this always follows a
 * publish the owner made, so an empty manager is a decision, not a gap.
 */
export async function recordOrgPlacement(input: {
  pubkey: string;
  tier: string | null;
  manager: string | null;
}): Promise<void> {
  await invokeTauri<void>("record_org_placement", {
    pubkey: input.pubkey,
    tier: input.tier,
    manager: input.manager,
  });
}
