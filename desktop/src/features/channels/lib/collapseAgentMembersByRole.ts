/**
 * Collapse agent members that fill the same workspace role into one entry.
 *
 * Each member of a workspace runs their own instance of a role, with its own
 * key and owner, so a channel legitimately contains N instances of one
 * colleague. Listing them all is what makes a workspace look like it employs
 * two Chiefs of Staff (docs/design/role-agents.html).
 *
 * The surviving entry is the viewer's own instance when they have one, so
 * anything the row offers (message, start, configure) acts on the agent that
 * will actually answer this member. Agents with no role are never merged: a
 * missing role means unknown, not "same as the other unknown".
 *
 * Order is preserved: a role keeps the position of its first occurrence.
 */
export function collapseAgentMembersByRole<T>(
  agents: readonly T[],
  roleOf: (agent: T) => string | null | undefined,
  isOwn: (agent: T) => boolean,
): T[] {
  const indexByRole = new Map<string, number>();
  const collapsed: T[] = [];

  for (const agent of agents) {
    const role = roleOf(agent)?.trim().toLowerCase();
    if (!role) {
      collapsed.push(agent);
      continue;
    }

    const existingIndex = indexByRole.get(role);
    if (existingIndex === undefined) {
      indexByRole.set(role, collapsed.length);
      collapsed.push(agent);
      continue;
    }

    // Same role, already represented. Upgrade the survivor to this member's
    // own instance if the one holding the slot is somebody else's.
    const incumbent = collapsed[existingIndex];
    if (incumbent !== undefined && !isOwn(incumbent) && isOwn(agent)) {
      collapsed[existingIndex] = agent;
    }
  }

  return collapsed;
}
