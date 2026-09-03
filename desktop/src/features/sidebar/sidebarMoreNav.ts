// desktop/src/features/sidebar/sidebarMoreNav.ts
/**
 * Which navigation a founder sees on day one, and how the rest gets in.
 *
 * The sidebar names nine destinations plus the channel list. For someone who
 * has one channel and one agent, seven of those nine are rooms with nothing in
 * them, and a first run that ends in a wall of empty destinations reads as a
 * product that has already been used by someone else. So a fresh founder gets
 * the five that have something behind them on day one, and the other five sit
 * under a "More" group they can open.
 *
 * Nobody else is affected: an imported identity, a second community, or any
 * account that did not sign up on this machine sees today's sidebar in full.
 * The group is a starting position, not a permission: opening it once keeps it
 * open, per identity, so the choice survives restarts and is never re-imposed.
 */
import { getStorageItem, setStorageItem } from "@/shared/lib/safeStorage";

/** The five that stay in the open list for everyone. */
export const PRIMARY_NAV_VIEWS = [
  "home",
  "work",
  "agents",
  "spend",
  "channel",
] as const;

/** The five that a fresh founder finds under "More". */
export const MORE_NAV_VIEWS = [
  "pulse",
  "projects",
  "content",
  "workflows",
  "discovery",
] as const;

export type MoreNavView = (typeof MORE_NAV_VIEWS)[number];

export function isMoreNavView(view: string): view is MoreNavView {
  return (MORE_NAV_VIEWS as readonly string[]).includes(view);
}

function storageKey(pubkey: string): string {
  return `colony.sidebar.more-open:${pubkey}`;
}

/**
 * Read-through cache of the persisted flag.
 *
 * Module-level, so it is community-scoped state by the rule in AGENTS.md and
 * `resetSidebarMoreNav` is wired into `resetCommunityState`. Keyed by pubkey
 * rather than cleared on identity change, so two identities on one machine
 * cannot read each other's answer even before a reset lands.
 */
const openByPubkey = new Map<string, boolean>();

export function resetSidebarMoreNav(): void {
  openByPubkey.clear();
}

export function readMoreNavOpen(pubkey: string | null | undefined): boolean {
  if (!pubkey) return false;
  const cached = openByPubkey.get(pubkey);
  if (cached !== undefined) return cached;
  const stored = getStorageItem(storageKey(pubkey)) === "true";
  openByPubkey.set(pubkey, stored);
  return stored;
}

/**
 * Record that the group was opened. Only the opening is persisted: closing it
 * again is a moment's tidying, not a request to be shown less of the product
 * for good, and re-hiding destinations someone has already found is worse than
 * leaving the group open.
 */
export function rememberMoreNavOpened(pubkey: string | null | undefined): void {
  if (!pubkey) return;
  openByPubkey.set(pubkey, true);
  setStorageItem(storageKey(pubkey), "true");
}

/**
 * Should this identity's sidebar carry a "More" group at all?
 *
 * Only a founder who signed up on this machine. Everyone else gets today's
 * flat list. A founder who has already opened the group still has it, still
 * open: {@link readMoreNavOpen} is what decides that, and it is why the group
 * never closes itself behind someone who has found what is in it.
 */
export function shouldGroupMoreNav({
  isFreshFounderIdentity,
  pubkey,
}: {
  isFreshFounderIdentity: boolean;
  pubkey: string | null | undefined;
}): boolean {
  return Boolean(isFreshFounderIdentity && pubkey);
}
