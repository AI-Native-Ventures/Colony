/**
 * Payload for the `agent` tab kind.
 *
 * A tab names the managed agent it renders and, once the composer has posted
 * its first message, the thread that message rooted. The thread id starts null
 * because a tab can be opened before anything has been said: the first send
 * creates the root and writes it back through `updateTabPayload`.
 *
 * Kept in its own module, free of React and of the workspace layer, so the
 * parse rules are testable under `node --test`.
 */

export type AgentTabPayload = {
  v: 1;
  agentPubkey: string;
  threadRootId: string | null;
};

/** Build a fresh payload for an agent tab. */
export function createAgentTabPayload(
  agentPubkey: string,
  threadRootId: string | null = null,
): AgentTabPayload {
  return { v: 1, agentPubkey, threadRootId };
}

/**
 * Read a stored payload back.
 *
 * Returns null for anything malformed — a tab restored from localStorage may
 * carry a payload this build never wrote, and a body that renders nothing is
 * better than one that throws inside a pane.
 */
export function parseAgentTabPayload(value: unknown): AgentTabPayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  const agentPubkey = record.agentPubkey;
  if (typeof agentPubkey !== "string" || agentPubkey.length === 0) return null;
  const threadRootId = record.threadRootId ?? null;
  if (threadRootId !== null && typeof threadRootId !== "string") return null;
  if (threadRootId === "") return null;
  return { v: 1, agentPubkey, threadRootId };
}

/** Bind a payload to a thread root. Returns the same object when unchanged. */
export function withThreadRootId(
  payload: AgentTabPayload,
  threadRootId: string | null,
): AgentTabPayload {
  if (payload.threadRootId === threadRootId) return payload;
  return { ...payload, threadRootId };
}
