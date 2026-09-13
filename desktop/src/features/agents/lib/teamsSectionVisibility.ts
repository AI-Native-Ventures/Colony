/**
 * Whether the Agents page shows its "Agent teams" section at all.
 *
 * The Welcome Team ships with the app and is in every store, so the section
 * was never empty: a person who has assembled no teams still got a heading, a
 * "New team" card and one team they did not make. That is furniture, and on a
 * store carrying leaked coordination records it was thirteen cards of it.
 *
 * So the section appears once there is a team the person actually made, and a
 * list holding nothing but teams this client seeds for itself counts as none.
 * Teams are still created from the blueprint flow and from an import, and an
 * error still shows, because a failed list must never read as "you have no
 * teams".
 *
 * "Seeded by this client" is the `builtin-team:` prefix, which covers both the
 * Welcome Team and every coordination record. `list_teams` already drops the
 * coordination ones; this keeps the section from reappearing on the strength
 * of one that slipped through. A blueprint's teams carry a `company-team:`
 * id and are the company's own, so they count.
 */

const CLIENT_SEEDED_TEAM_ID_PREFIX = "builtin-team:";

export function teamsSectionIsVisible(
  teams: readonly { id: string }[],
  hasError: boolean,
): boolean {
  if (hasError) {
    return true;
  }
  return teams.some(
    (team) => !team.id.startsWith(CLIENT_SEEDED_TEAM_ID_PREFIX),
  );
}
