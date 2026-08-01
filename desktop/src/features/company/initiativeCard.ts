/**
 * Reading an owner's click on an Initiative card.
 *
 * The card carries which initiative it acts on. Everything else it shows is a
 * snapshot written when the card was posted, and is deliberately not trusted:
 * the relay-authored head is re-read at the moment of the click, so a card that
 * has gone stale in a channel cannot start work under a status that changed.
 */

export const START_ACTION_ID = "initiative.start";
export const DECLINE_ACTION_ID = "initiative.decline";

/** A Block instance is authored elsewhere, so nothing about it is guaranteed. */
export type InitiativeInstanceData = unknown;

export type InitiativeCardRequest = {
  initiativeId: string;
  companyId: string;
  intent: "start" | "decline";
};

/** The identifier grammar `buzz_core::company` accepts. */
const RECORD_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

function readIds(
  data: InitiativeInstanceData | null | undefined,
): { initiativeId: string; companyId: string } | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;
  const initiativeId = fields.initiative_id;
  const companyId = fields.company_id;
  if (typeof initiativeId !== "string" || !RECORD_ID.test(initiativeId)) {
    return null;
  }
  if (typeof companyId !== "string" || !RECORD_ID.test(companyId)) return null;
  return { initiativeId, companyId };
}

/** Whether this action id belongs to the Initiative card. */
export function isInitiativeAction(actionId: string): boolean {
  return actionId === START_ACTION_ID || actionId === DECLINE_ACTION_ID;
}

/**
 * Read what an Initiative card click asks for, or null when the card is not
 * one this client can act on.
 */
export function readInitiativeCardAction(
  data: InitiativeInstanceData | null | undefined,
  actionId: string,
): InitiativeCardRequest | null {
  if (!isInitiativeAction(actionId)) return null;
  const ids = readIds(data);
  if (!ids) return null;
  return {
    ...ids,
    intent: actionId === START_ACTION_ID ? "start" : "decline",
  };
}

/**
 * The inputs the Initiative card's actions carry.
 *
 * An action that declares required inputs is not directly clickable, because
 * the renderer has no way to know what to send. These inputs are not questions
 * for the owner though, they are facts about the card, so they are derived from
 * it rather than asked for.
 */
export function resolveInitiativeActionInputs(
  data: InitiativeInstanceData | null | undefined,
): Map<string, Record<string, unknown>> {
  const inputs = new Map<string, Record<string, unknown>>();
  const ids = readIds(data);
  if (!ids) return inputs;
  for (const actionId of [START_ACTION_ID, DECLINE_ACTION_ID]) {
    inputs.set(actionId, { initiative_id: ids.initiativeId });
  }
  return inputs;
}
