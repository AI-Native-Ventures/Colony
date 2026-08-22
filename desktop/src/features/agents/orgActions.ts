import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import type { AgentRank } from "@/features/agents/employeeHeads";
import {
  KIND_EMPLOYEE_UPDATE,
  KIND_HIRE_REQUEST,
} from "@/shared/constants/kinds";

/**
 * Publishing the owner-signed operations behind the People and Roles
 * screen: hiring (kind 9045) and rank/manager changes for EXISTING
 * employees (kind 9046). Both are validated by the relay at ingest; the
 * client builds the exact tag shapes `buzz-core/src/employee.rs` parses and
 * surfaces any relay rejection verbatim -- the relay's message names the
 * rule that fired, and paraphrasing it would hide that.
 */

export type HireRequestInput = {
  /** Stable role slug (already validated with isValidRoleSlug). */
  role: string;
  name: string;
  rank: AgentRank;
  /** Manager pubkey, or null to hire with no reporting line. */
  manager: string | null;
};

export async function publishHireRequest(
  input: HireRequestInput,
): Promise<string> {
  const tags: string[][] = [
    ["role", input.role],
    ["name", input.name],
    ["rank", input.rank],
  ];
  if (input.manager) {
    tags.push(["manager", input.manager]);
  }
  const event = await signRelayEvent({
    kind: KIND_HIRE_REQUEST,
    content: "",
    tags,
  });
  await relayClient.publishEvent(
    event,
    "Timed out while filing the hire request.",
    "Failed to file the hire request.",
  );
  return event.id;
}

export type EmployeeUpdateInput = {
  /** The employee being changed; the `p` tag. */
  pubkey: string;
  /** New rank when the request re-ranks. */
  rank?: AgentRank;
  /**
   * New manager when the request re-assigns. Absent means "keep the current
   * line": kind 9046 has no explicit clear, because an executive drops its
   * line implicitly on promotion (the relay enforces that).
   */
  manager?: string;
};

export async function publishEmployeeUpdate(
  input: EmployeeUpdateInput,
): Promise<string> {
  if (!input.rank && input.manager === undefined) {
    throw new Error("An update must change at least one of rank or manager.");
  }
  const tags: string[][] = [["p", input.pubkey]];
  if (input.rank) {
    tags.push(["rank", input.rank]);
  }
  if (input.manager !== undefined) {
    tags.push(["manager", input.manager]);
  }
  const event = await signRelayEvent({
    kind: KIND_EMPLOYEE_UPDATE,
    content: "",
    tags,
  });
  await relayClient.publishEvent(
    event,
    "Timed out while updating the employee.",
    "Failed to update the employee.",
  );
  return event.id;
}

/**
 * Retire an employee: kind 9046 carrying only the `retire` flag, which is
 * mutually exclusive with rank and manager changes -- one request, one
 * decision about one person.
 *
 * The relay refuses at ingest when the employee still has direct reports,
 * naming them by pubkey; that message is surfaced verbatim so the owner can
 * reassign before retrying. Retirement is not deletion: the row, its history,
 * and its past decisions all stay on the relay.
 */
export async function publishEmployeeRetirement(input: {
  pubkey: string;
}): Promise<string> {
  const event = await signRelayEvent({
    kind: KIND_EMPLOYEE_UPDATE,
    content: "",
    tags: [
      ["p", input.pubkey],
      ["retire", "true"],
    ],
  });
  await relayClient.publishEvent(
    event,
    "Timed out while retiring the employee.",
    "Failed to retire the employee.",
  );
  return event.id;
}
