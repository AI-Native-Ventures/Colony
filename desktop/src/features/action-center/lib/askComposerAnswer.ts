export type AskComposerAnswer = {
  decision: string;
  rationale: string;
  /** The `options[].label` picked, or null on a free-text answer. The
   * threaded reply path only needs `decision`/`rationale` (the reply is
   * plain text either way); the thread-less card path forwards this
   * straight to `answerAsk`. */
  optionLabel: string | null;
};

/**
 * The answer an option tap produces. Always valid (spec: "Option tap with
 * empty rationale works" -- picking a labeled option IS the answer, so
 * there is nothing here to validate), text "Go with: <label>" plus any
 * typed rationale, through whichever path (threaded reply, or the
 * thread-less resolution card) already applies to this ask.
 */
export function buildOptionAnswer(
  label: string,
  rationale: string,
): AskComposerAnswer {
  return {
    decision: `Go with: ${label}`,
    rationale: rationale.trim(),
    optionLabel: label,
  };
}

/**
 * The answer a free-text submit produces, or null when the decision box is
 * empty. A `decision`/`question` ask still requires a non-null `answer`
 * (the relay's `parse_resolution` rule), and an empty free-text box is not
 * one -- unlike an option tap, which always carries a real answer.
 */
export function buildFreeTextAnswer(
  decision: string,
  rationale: string,
): AskComposerAnswer | null {
  const trimmedDecision = decision.trim();
  if (trimmedDecision === "") return null;
  return {
    decision: trimmedDecision,
    rationale: rationale.trim(),
    optionLabel: null,
  };
}
