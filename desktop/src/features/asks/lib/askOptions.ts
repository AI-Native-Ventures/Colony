/**
 * Structured ask options (NIP-IQ kind 44300 content).
 *
 * The Ask content schema carries `options: [{label, consequence, recommended?}]`
 * and a `default_option` naming one of those labels. `buzz_core`'s `parse_ask`
 * does NOT validate the array's shape: it only checks that `default_option`,
 * when present, matches some `options[].label`, and `ParsedAsk` does not even
 * carry the options through. So options are a client-side contract, and this
 * reader is deliberately tolerant: anything without a usable `label` is
 * dropped and the rest still render, because a single malformed entry must
 * not turn a pick-one ask back into an essay question.
 *
 * `recommended` and `default_option` are DIFFERENT things and may name
 * different options. Recommended is the filing agent's advice. The default is
 * what the relay's sweep executes if the deadline passes with nobody
 * answering, and NIP-IQ forbids it entirely on a hard-list `category`
 * (`spend`, `external_send`, `hiring`, `legal`, `pricing`, `deletion`,
 * `vendor`) and on a `stall` ask, so plenty of asks have a recommendation and
 * no default at all.
 */

/** One selectable option, as the owner sees it. */
export type AskOption = {
  label: string;
  /** What this choice causes. The whole reason options beat free text. */
  consequence: string | null;
  /** The filing agent's advice. */
  recommended: boolean;
  /** Fires by itself if the deadline passes unanswered. */
  isDefault: boolean;
};

/** Everything the card needs to render an ask's choices. */
export type AskOptionSet = {
  options: AskOption[];
  /** The `default_option` label, when the ask states one. */
  defaultOption: string | null;
};

const EMPTY_OPTION_SET: AskOptionSet = { options: [], defaultOption: null };

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Read the options an ask offers off its raw content. Never throws: an ask
 * whose content will not parse simply has no options and falls back to the
 * free-text answer box.
 */
export function readAskOptions(rawContent: string): AskOptionSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return EMPTY_OPTION_SET;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return EMPTY_OPTION_SET;
  }
  const fields = parsed as Record<string, unknown>;
  const rawOptions = Array.isArray(fields.options) ? fields.options : [];
  const defaultOption = trimmedString(fields.default_option);

  const seen = new Set<string>();
  const options: AskOption[] = [];
  for (const entry of rawOptions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const label = trimmedString(record.label);
    // A label is the identity the resolution is written against, so a
    // duplicate would make the answer ambiguous. Keep the first.
    if (label === null || seen.has(label)) continue;
    seen.add(label);
    options.push({
      label,
      consequence: trimmedString(record.consequence),
      recommended: record.recommended === true,
      isDefault: defaultOption !== null && label === defaultOption,
    });
  }

  return {
    options,
    // Only report a default the owner can actually see in the list. The relay
    // rejects a `default_option` that names no option at filing time, so this
    // only bites on an ask whose matching entry was itself malformed.
    defaultOption:
      defaultOption !== null && seen.has(defaultOption) ? defaultOption : null,
  };
}

/**
 * Build the `answer` object a kind 44301 resolution carries.
 *
 * The protocol says `answer` is "any JSON" and a `decision`/`question` ask
 * merely requires it to be non-null (`parse_resolution`). The shape here is
 * chosen to match what already exists on both sides rather than invented:
 *
 * - The relay's own default execution writes
 *   `{"answer":{"option":"<default_option>"},"default_executed":true}`
 *   (`interrupt_runtime::execute_default`), so `option` is the protocol's own
 *   key for "a named option was chosen".
 * - This app's existing human answers write `{decision, rationale}`, and
 *   `askResolution.ts` reads all three keys already.
 *
 * So a chosen option is published as `option` AND mirrored into `decision`,
 * which keeps every existing reader (the resolution notice, the decision log
 * surfaces, an agent reading `answer.decision`) showing something meaningful
 * instead of an empty answer. `default_executed` is never set here: only the
 * relay may claim a default fired.
 */
export function buildAskAnswer(input: {
  optionLabel?: string | null;
  decision: string;
  rationale: string;
}): Record<string, string> {
  const option = input.optionLabel?.trim() ?? "";
  const decision = input.decision.trim();
  const rationale = input.rationale.trim();
  const answer: Record<string, string> = {};
  if (option !== "") {
    answer.option = option;
    answer.decision = decision === "" ? option : decision;
  } else {
    answer.decision = decision;
  }
  answer.rationale = rationale;
  return answer;
}
