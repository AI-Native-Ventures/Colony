/**
 * Whether the Agents page shows its "Agent teams" section at all, and which
 * team ids that page never draws a card for.
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
 * `list_teams` keeps this community's own coordination team, because the same
 * list resolves a Task's owning team for mentions, the new-task dialog, the
 * task thread and both deploy dialogs. It is plumbing there and furniture
 * here, so the Agents page is the one surface that filters it out.
 *
 * "Seeded by this client" is the `builtin-team:` prefix, which covers both the
 * Welcome Team and every coordination record. A blueprint's teams carry a
 * `company-team:` id and are the company's own, so they count.
 */

const CLIENT_SEEDED_TEAM_ID_PREFIX = "builtin-team:";
const COORDINATION_TEAM_ID_SUFFIX = ":company-coordination";

/**
 * Whether `id` names a coordination team this client seeds for itself.
 *
 * Mirrors the Rust `is_coordination_team_id`: the `builtin-team:` prefix keeps
 * a blueprint's `company-team:...:company-coordination` out, and the leading
 * colon on the suffix makes the slug match on a segment boundary rather than
 * as bare trailing text.
 */
export function isCoordinationTeamId(id: string): boolean {
  return (
    id.startsWith(CLIENT_SEEDED_TEAM_ID_PREFIX) &&
    id.endsWith(COORDINATION_TEAM_ID_SUFFIX)
  );
}

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
