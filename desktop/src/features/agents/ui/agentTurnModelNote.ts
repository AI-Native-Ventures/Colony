/**
 * What the Activity pane says about which model actually answered a turn.
 *
 * A reply served by a fallback used to be indistinguishable from one served by
 * the agent's own model, and a turn that exhausted the whole chain showed the
 * last provider's raw body. Both are answered here, from the model the harness
 * reports in its usage payload (`crates/buzz-acp/src/usage.rs`, field `model`)
 * and the chain the desktop already resolves for the agent.
 *
 * Pure: the rendering is one quiet line, and everything it can say is decided
 * in this file.
 */

/**
 * The models a turn may be served by, in the order they are tried: the agent's
 * own model first, then its fallbacks. Entries are compared as the harness
 * reports them, trimmed, with empty ids dropped.
 */
export function effectiveModelChain(
  primaryModel: string,
  fallbacks: readonly string[],
): string[] {
  const seen = new Set<string>();
  return [primaryModel, ...fallbacks]
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (entry.length === 0 || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
}

/**
 * The line under a reply, or null when there is nothing worth saying.
 *
 * Nothing is said when the harness reported no model, or when the model that
 * answered is the one the agent was asked to use. A served model the chain
 * does not contain still gets named: knowing something else answered is the
 * point, and a position we cannot vouch for is worse than no position.
 */
export function turnServedModelNote({
  chain,
  servedModel,
}: {
  /** The effective chain, primary first. */
  chain: readonly string[];
  servedModel: string | null | undefined;
}): string | null {
  const served = servedModel?.trim() ?? "";
  if (served.length === 0) return null;
  const primary = chain[0]?.trim() ?? "";
  if (served === primary) return null;
  const index = chain.findIndex((entry) => entry.trim() === served);
  const fallbackCount = Math.max(chain.length - 1, 0);
  if (index <= 0 || fallbackCount === 0) return `Answered by ${served}`;
  return `Answered by ${served}, fallback ${index} of ${fallbackCount}`;
}

/**
 * Whether a turn error is the whole chain having failed rather than one
 * request failing.
 *
 * The harness logs each hop as `llm: fell back` and gives up with `exhausted
 * retries` plus the last provider's body, which is the body the pane used to
 * show. One model and no fallbacks cannot exhaust a chain, so that case keeps
 * its original error.
 */
export function chainExhaustedFailure({
  chain,
  message,
}: {
  chain: readonly string[];
  message: string;
}): { ids: string[]; text: string } | null {
  if (chain.length < 2) return null;
  const lowered = message.toLowerCase();
  if (
    !lowered.includes("exhausted retries") &&
    !lowered.includes("llm: fell back")
  ) {
    return null;
  }
  return {
    ids: [...chain],
    text: `All ${chain.length} models failed`,
  };
}
