/**
 * Turning an owner's click on Approve into a company.
 *
 * The Blueprint Block carries the exact executable document it renders, plus
 * the hash of that document. Approving sends both: the backend re-parses the
 * document under the trusted role catalog and refuses it if the hash does not
 * match, so what executes is what the owner was shown a hash of.
 */

/** The action id the Blueprint Block's approve control carries. */
export const APPROVE_ACTION_ID = "company-blueprint.approve";

/**
 * Read as unknown fields on purpose: a Block instance is agent-authored JSON,
 * so nothing about its shape is guaranteed until it is checked here.
 */
export type BlueprintInstanceData = unknown;

export type BlueprintApprovalRequest = {
  blueprint: string;
  expectedHash: string;
  requestId: string;
};

/** The hash shape the backend will compare against. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Read the approval out of a Blueprint Block instance.
 *
 * Returns null rather than throwing when the instance is not a Blueprint or is
 * missing what approval needs: a Block is agent-authored, so a malformed one
 * is an expected input, not an exceptional one. Approving on a partial
 * instance would send the backend a document the owner never saw a hash of.
 */
export function readBlueprintApproval(
  data: BlueprintInstanceData | null | undefined,
): BlueprintApprovalRequest | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;

  const blueprint = fields.blueprint;
  const expectedHash = fields.blueprint_hash;
  const requestId = fields.request_id;

  if (typeof blueprint !== "string" || blueprint.trim() === "") return null;
  if (typeof expectedHash !== "string" || !SHA256_HEX.test(expectedHash)) {
    return null;
  }
  if (typeof requestId !== "string" || requestId.trim() === "") return null;

  return { blueprint, expectedHash, requestId };
}

/** Whether this action is the one that creates a company. */
export function isBlueprintApproval(actionId: string): boolean {
  return actionId === APPROVE_ACTION_ID;
}

/**
 * The inputs the Blueprint Block's actions carry.
 *
 * An action that declares required inputs cannot be clicked directly: the
 * renderer has no way to know what to send. The approve action's inputs are
 * not free-form though, they are facts about the instance being approved, so
 * they are derived from it here rather than asked for.
 */
export function resolveBlueprintActionInputs(
  data: BlueprintInstanceData | null | undefined,
): Map<string, Record<string, unknown>> {
  const inputs = new Map<string, Record<string, unknown>>();
  const approval = readBlueprintApproval(data);
  if (approval) {
    inputs.set(APPROVE_ACTION_ID, {
      request_id: approval.requestId,
      blueprint_hash: approval.expectedHash,
    });
  }
  return inputs;
}
