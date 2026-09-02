/** The minimum a team has to expose to be named. */
type NamedTeam = { id: string; name: string };

/**
 * The coordination team's id ends with this slug on every shape it has ever
 * had: the legacy device-wide `builtin-team:company-coordination`, the
 * per-community `builtin-team:<disc>:company-coordination`, and a
 * blueprint's `company-team:<scope>:<company>:company-coordination`.
 */
const COORDINATION_TEAM_SLUG = "company-coordination";

/**
 * How to label the team a task is owned or reviewed by.
 *
 * The teams list is scoped to the community the app is looking at, and a
 * task's `owningTeamId` is whatever the relay recorded when it was minted, so
 * a lookup miss is ordinary rather than a fault: the team may predate this
 * community's coordination record, or the task may have been minted on
 * another device before its team event synced here.
 *
 * A miss on a coordination id gets the constant name rather than the id.
 * There is exactly one coordination team per community and it is always
 * called "Company Coordination", so the name is knowable without the record,
 * and printing the id instead turns the thread header into hex. Any other
 * miss falls back to the id, which is the existing behaviour and at least
 * says which team is missing.
 */
export function teamDisplayName(
  teams: readonly NamedTeam[] | undefined,
  teamId: string,
): string {
  const match = teams?.find((team) => team.id === teamId);
  if (match) return match.name;
  if (teamId.endsWith(COORDINATION_TEAM_SLUG)) return "Company Coordination";
  return teamId;
}
