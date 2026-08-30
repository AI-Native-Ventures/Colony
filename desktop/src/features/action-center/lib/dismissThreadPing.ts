import { THREAD_PINGS_QUERY_KEY, type ThreadPing } from "./threadPings";

/** The reaction content a dismiss publishes. Any owner reaction already
 * suppresses a ping (see selectUnansweredPings), so this specific emoji is a
 * convention for a deliberate dismiss, not a detection requirement. */
export const PING_DISMISS_EMOJI = "✅";

export type DismissThreadPingDependencies = {
  addReaction: (eventId: string, emoji: string) => Promise<void>;
  invalidateQueries: (queryKey: readonly unknown[]) => Promise<void> | void;
};

/**
 * Dismisses a ping by reacting to it -- not by any local or optimistic-only
 * state. The relay-stored kind:7 reaction is what makes "dismissed" sync
 * across devices and stay visible to the agent (spec: "Dismissed-ping
 * sync"). No new event kind, no localStorage.
 */
export async function dismissThreadPing(
  ping: Pick<ThreadPing, "id">,
  dependencies: DismissThreadPingDependencies,
): Promise<void> {
  await dependencies.addReaction(ping.id, PING_DISMISS_EMOJI);
  await dependencies.invalidateQueries(THREAD_PINGS_QUERY_KEY);
}
