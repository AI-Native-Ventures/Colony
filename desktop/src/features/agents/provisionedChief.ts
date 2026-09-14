/**
 * Which agent is the Chief of Staff in this community.
 *
 * There are two candidates and only one of them is the office. Colony
 * provisions a `chief-of-staff` employee into every community and the desktop
 * adopts it into a record carrying `provisioned: "chief-of-staff"`. The older
 * desktop-builtin instance (`builtin:fizz`, minted by the welcome flow) is
 * legacy: where the provisioned record exists it is the Chief of Staff, and
 * the built-in one is retired rather than treated as a second holder.
 *
 * Every chief lookup goes through here so the preference is written once. A
 * lookup that matches only on the starter persona id silently picks the
 * built-in instance in a community that has both, which is the duplicate the
 * roster was showing.
 */
import type { ManagedAgent } from "@/shared/api/types";
import { STARTER_PERSONA_IDS } from "@/shared/constants/starterPersonas";

/**
 * The provisioned handle Colony mints the Chief of Staff under. Same string as
 * `CHIEF_OF_STAFF_ROLE_ID`, but a different axis: this is the employee handle
 * on the record, not the role id on a persona.
 */
export const PROVISIONED_CHIEF_OF_STAFF_HANDLE = "chief-of-staff";

/** Whether `agent` is the employee Colony provisions as Chief of Staff. */
export function isProvisionedChiefOfStaff(agent: ManagedAgent): boolean {
  return agent.provisioned === PROVISIONED_CHIEF_OF_STAFF_HANDLE;
}

/** Whether `agent` is the legacy desktop-builtin Chief of Staff instance. */
export function isBuiltInChiefOfStaff(agent: ManagedAgent): boolean {
  return agent.personaId === STARTER_PERSONA_IDS.fizz;
}

/**
 * Whether `agent` holds the Chief of Staff office at all, by either route.
 *
 * Callers that merely need to recognise the chief (an onboarding scout check,
 * a validation that the agent shown is still the one proposed) use this;
 * callers that must choose ONE use {@link pickChiefOfStaff}.
 */
export function isChiefOfStaffAgent(agent: ManagedAgent): boolean {
  return isProvisionedChiefOfStaff(agent) || isBuiltInChiefOfStaff(agent);
}

/**
 * The Chief of Staff for this community: the provisioned employee when one is
 * adopted here, else the built-in instance, else null.
 *
 * `agents` is expected to be a community-scoped roster (`listManagedAgents`
 * already scopes by relay and owner), so no relay argument is taken.
 */
export function pickChiefOfStaff(
  agents: readonly ManagedAgent[] | undefined,
): ManagedAgent | null {
  const roster = agents ?? [];
  return (
    roster.find(isProvisionedChiefOfStaff) ??
    roster.find(isBuiltInChiefOfStaff) ??
    null
  );
}
