/**
 * Whether an agent-directed message is asking for work.
 *
 * Every send to an agent used to mint a Task, so "are you there?" appeared in
 * Work beside real instructions, with `InProgress` status and the raw message
 * as its title. Accounting for a greeting as work makes the task list a
 * transcript rather than a list of work.
 *
 * The bar is deliberately low and the default is yes. A missing Task is worse
 * than a spurious one: the work still happens, the agent turn is still paid
 * for, and nothing records it. So only messages that match a known
 * conversational shape are skipped, and anything with an actual instruction in
 * it is kept even when it is short.
 */

/** Leading mentions, markdown emphasis, and punctuation the shape check ignores. */
function normalize(content: string): string {
  return (
    content
      // Mentions the composer inserted: "@Chief of Staff are you there?".
      // Role names carry lowercase connectors ("Chief of Staff"), so the run
      // continues through those as well as through capitalised words. Without
      // the connectors the leftover "of staff" made every message to the Chief
      // of Staff look like an instruction.
      .replace(
        /@[\w-]+(?:\s+(?:of|the|and|for|de|van|von|da|di)\b|\s+[A-Z][\w-]*)*/g,
        " ",
      )
      // Markdown emphasis and code fences carry no meaning for this decision.
      .replace(/[*_`~#>]/g, " ")
      .replace(/[!?.,:;]+/g, " ")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Openers, acknowledgements and presence checks: complete messages that ask
 * for nothing. Matched whole, never as a prefix, so "thanks, now ship it"
 * still counts as work.
 */
const CONVERSATIONAL = new Set([
  "hi",
  "hey",
  "hello",
  "yo",
  "hiya",
  "morning",
  "good morning",
  "good afternoon",
  "good evening",
  "thanks",
  "thank you",
  "thanks so much",
  "ta",
  "cheers",
  "ok",
  "okay",
  "k",
  "cool",
  "nice",
  "great",
  "perfect",
  "got it",
  "understood",
  "noted",
  "sure",
  "yes",
  "no",
  "yep",
  "nope",
  "sounds good",
  "well done",
  "nvm",
  "never mind",
  "are you there",
  "you there",
  "are you here",
  "you here",
  "still there",
  "are you awake",
  "you up",
  "ping",
  "test",
  "testing",
  "hello there",
  "are you alive",
  "you alive",
  "are you working",
]);

/**
 * True when this message should mint a Task.
 *
 * An empty message never does: there is no instruction to record. Everything
 * else is work unless the whole message is one of the conversational shapes
 * above.
 */
export function impliesWork(content: string): boolean {
  const normalized = normalize(content);
  if (normalized === "") return false;
  return !CONVERSATIONAL.has(normalized);
}
