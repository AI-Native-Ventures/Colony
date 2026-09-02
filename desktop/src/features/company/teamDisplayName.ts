/** The minimum a team has to expose to be named. */
type NamedTeam = { id: string; name: string };

/**
 * How to label the team a task is owned or reviewed by.
 *
 * The teams list is scoped to the community the app is looking at, and a
 * task's `owningTeamId` is whatever the relay recorded when it was minted, so
 * a lookup miss is ordinary rather than a fault: the team may predate this
 * community's coordination record, or the task may have been minted on
 * another device before its team event synced here.
 *
 * A miss falls back to the raw id. That is the long-standing contract of the
 * task detail dialog, and it says which team is missing rather than papering
 * over the gap with a guessed label.
 */
export function teamDisplayName(
  teams: readonly NamedTeam[] | undefined,
  teamId: string,
): string {
  const match = teams?.find((team) => team.id === teamId);
  return match ? match.name : teamId;
}
