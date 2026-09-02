/**
 * Pure validation for the "New initiative" form.
 *
 * `Initiative.title` is capped at 200 characters (`MAX_NAME_LEN` in
 * buzz-core) and `plan_user_initiative` refuses a longer one, so checking it
 * here fails the form before anything is signed rather than after.
 */

export const MAX_INITIATIVE_TITLE_LEN = 200;

export type NewInitiativeFormInput = {
  /** Channel the initiative is raised in. Required: the contract has no
   * company-wide default for it. */
  channelId: string;
  title: string;
  summary: string;
  /** Cost centre the initiative's work is charged to. */
  costCentreId: string;
};

export type NewInitiativeValidation =
  | {
      ok: true;
      channelId: string;
      title: string;
      /** Null when the field was left empty: absent and empty mean the same
       * thing to the relay, and null says so without a second encoding. */
      summary: string | null;
      costCentreId: string;
    }
  | { ok: false; message: string };

/** Validate and normalize a "New initiative" form submission. */
export function validateNewInitiativeInput(
  input: NewInitiativeFormInput,
): NewInitiativeValidation {
  if (!input.channelId) {
    return { ok: false, message: "Choose a channel for this initiative." };
  }
  const title = input.title.trim();
  if (!title) {
    return { ok: false, message: "Give this initiative a title." };
  }
  if (title.length > MAX_INITIATIVE_TITLE_LEN) {
    return {
      ok: false,
      message: `Title is too long (max ${MAX_INITIATIVE_TITLE_LEN} characters).`,
    };
  }
  // Asked for rather than defaulted. The backend would fall back to the
  // company's internal cost centre, which silently charges client work to
  // overhead and is invisible until someone reads the ledger.
  if (!input.costCentreId) {
    return { ok: false, message: "Choose a cost centre for this initiative." };
  }
  const summary = input.summary.trim();
  return {
    ok: true,
    channelId: input.channelId,
    title,
    summary: summary === "" ? null : summary,
    costCentreId: input.costCentreId,
  };
}
