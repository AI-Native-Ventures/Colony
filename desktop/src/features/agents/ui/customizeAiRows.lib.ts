/**
 * The inherited/custom row model behind the Customize tab of
 * `AgentDefinitionDialog`.
 *
 * Customize used to be a flat list of empty pickers: switching to it showed
 * "Choose a provider" with a required star and a disabled Save even though the
 * agent was already running fine on inherited defaults. The tab is now one row
 * per setting, seeded from what the agent inherits, and each row says whether
 * it still follows the defaults or was overridden here.
 *
 * Pure so both the dialog (which needs "did the user override anything?" at
 * submit) and the rows component (which needs a pill per row) read the same
 * answer.
 */

export type CustomizeAiRowId =
  | "harness"
  | "provider"
  | "model"
  | "fallbacks"
  | "reasoning";

export const CUSTOMIZE_AI_ROW_LABELS: Record<CustomizeAiRowId, string> = {
  harness: "Harness",
  provider: "Provider",
  model: "Model",
  fallbacks: "Fallbacks",
  reasoning: "Reasoning",
};

/** The draft value of each row next to the value it would inherit. */
export type CustomizeAiValues = {
  harness: { current: string; inherited: string };
  /**
   * `visible` is false for harnesses that drive their own provider (Codex,
   * Claude). A hidden row can never be overridden, so it never counts.
   */
  provider: { current: string; inherited: string; visible: boolean };
  model: { current: string; inherited: string };
  /** True once the agent carries an authored chain rather than inheriting one. */
  fallbacks: { authored: boolean };
  reasoning: { current: string; inherited: string };
};

/**
 * A row is custom when its draft differs from what it would inherit. Entering
 * Customize copies the inherited values in, so every row starts inherited and
 * only the user's own edit flips a pill.
 */
export function rowIsCustom(current: string, inherited: string): boolean {
  return current.trim() !== inherited.trim();
}

export function customizeAiRowCustomFlags(
  values: CustomizeAiValues,
): Record<CustomizeAiRowId, boolean> {
  return {
    harness: rowIsCustom(values.harness.current, values.harness.inherited),
    provider:
      values.provider.visible &&
      rowIsCustom(values.provider.current, values.provider.inherited),
    model: rowIsCustom(values.model.current, values.model.inherited),
    fallbacks: values.fallbacks.authored,
    reasoning: rowIsCustom(
      values.reasoning.current,
      values.reasoning.inherited,
    ),
  };
}

/**
 * Whether anything on the tab was actually overridden.
 *
 * A Customize save with every row still inherited stores no pins at all: it
 * takes the same payload path as "Use agent defaults", so opening the tab and
 * pressing Save cannot quietly freeze today's defaults onto the agent.
 */
export function customizeAiHasOverrides(values: CustomizeAiValues): boolean {
  return Object.values(customizeAiRowCustomFlags(values)).some(Boolean);
}

/**
 * The Provider row's key status. The API key is a note here rather than a full
 * input between Provider and Model, and only opens into an input when the user
 * asks for a different one -- or straight away when the provider needs a key
 * that no layer supplies, because that one is not a preference, it is what
 * stops the agent from running.
 */
export function providerKeyNote({
  isInherited,
  isRequired,
}: {
  isInherited: boolean;
  isRequired: boolean;
}): string {
  if (isRequired) return "Key: needed";
  return isInherited ? "Key: from defaults" : "Key: set for this agent";
}

/** Display text for a row: the draft, else what it inherits, else a dash. */
export function rowDisplayValue(
  current: string,
  inherited: string,
  emptyLabel = "Not configured",
): string {
  return current.trim() || inherited.trim() || emptyLabel;
}
