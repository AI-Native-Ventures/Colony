/**
 * The communication graph model: who talked to whom in one project channel.
 *
 * Derived entirely from relay events the channel already loads plus the open
 * asks the owner already reads, so the graph adds no storage and no new relay
 * query. Pure and deterministic: the same inputs always produce the same
 * node/edge order, which is what lets the layout and the spec assert on it.
 */
import { getThreadReference } from "@/features/messages/lib/threading";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_STREAM_MESSAGE_V2,
} from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";

/** Message kinds that carry a mention or a thread reply. */
const MESSAGE_KINDS: ReadonlySet<number> = new Set([
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_EDIT,
]);

export type CommGraphNodeKind = "owner" | "agent";

export type CommGraphNode = {
  pubkey: string;
  kind: CommGraphNodeKind;
};

export type CommGraphEdgeKind = "message" | "ask";

export type CommGraphEdge = {
  from: string;
  to: string;
  count: number;
  /** Unix seconds of the most recent interaction on this edge. */
  lastAt: number;
  kind: CommGraphEdgeKind;
};

/**
 * One interaction behind an edge. The right rail renders these; the edges are
 * just their aggregate, so both come out of one pass over the events.
 */
export type CommInteraction = {
  /** Event id for a message, ask id for an ask. */
  id: string;
  from: string;
  to: string;
  /** Unix seconds. */
  at: number;
  kind: CommGraphEdgeKind;
  /** First non-empty line of the body, for the rail's one-line preview. */
  text: string;
  /** Thread root this interaction belongs to, when it has one. */
  rootId: string | null;
};

/**
 * The slice of an open ask the graph needs. `OpenAsk` satisfies it, so the
 * tile hands its list straight through.
 */
export type CommGraphAsk = {
  id: string;
  filerPubkey: string;
  createdAt: number;
  headline: string;
  threadId: string | null;
};

export type CommGraph = {
  nodes: readonly CommGraphNode[];
  edges: readonly CommGraphEdge[];
  interactions: readonly CommInteraction[];
};

export type BuildCommGraphInput = {
  events: readonly RelayEvent[];
  ownerPubkey: string;
  agentPubkeys: readonly string[];
  openAsks: readonly CommGraphAsk[];
  /** How far back messages count, in milliseconds. */
  windowMs: number;
  /** Current time in milliseconds. */
  now: number;
};

/** First non-empty line of a body, collapsed to single spaces. */
function firstLine(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/\s+/g, " ");
    if (trimmed) return trimmed;
  }
  return "";
}

/** Mentioned pubkeys: every `p` tag that is not the author's own. */
function mentionTargets(event: RelayEvent, author: string): string[] {
  const targets: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "p" || typeof tag[1] !== "string") continue;
    const pubkey = normalizePubkey(tag[1]);
    if (!pubkey || pubkey === author) continue;
    targets.push(pubkey);
  }
  return targets;
}

/**
 * Build the graph.
 *
 * An edge A→B is a message A authored that either mentions B or replies into a
 * thread B started. Open asks an agent raised are a second edge kind, always
 * pointing at the owner: an ask that is open is outstanding now, so it is
 * included whatever the message window is — the window narrows the
 * conversation, not the owner's queue.
 *
 * Only the owner and the agents handed in are nodes, every agent is kept even
 * with no traffic (an idle teammate is information), and an author never gets
 * an edge to itself.
 */
export function buildCommGraph({
  events,
  ownerPubkey,
  agentPubkeys,
  openAsks,
  windowMs,
  now,
}: BuildCommGraphInput): CommGraph {
  const owner = normalizePubkey(ownerPubkey);
  const agents: string[] = [];
  const agentSet = new Set<string>();
  for (const candidate of agentPubkeys) {
    const pubkey = normalizePubkey(candidate);
    if (!pubkey || pubkey === owner || agentSet.has(pubkey)) continue;
    agentSet.add(pubkey);
    agents.push(pubkey);
  }

  const participants = new Set<string>(agentSet);
  if (owner) participants.add(owner);

  const cutoff = Math.floor((now - windowMs) / 1_000);
  const authorById = new Map<string, string>();
  for (const event of events) {
    authorById.set(event.id, normalizePubkey(event.pubkey));
  }

  const interactions: CommInteraction[] = [];

  for (const event of events) {
    if (!MESSAGE_KINDS.has(event.kind)) continue;
    if (event.created_at < cutoff) continue;
    const author = normalizePubkey(event.pubkey);
    if (!participants.has(author)) continue;

    const thread = getThreadReference(event.tags);
    const rootId = thread.rootId ?? thread.parentId;
    const targets = new Set(mentionTargets(event, author));
    if (rootId) {
      const rootAuthor = authorById.get(rootId);
      if (rootAuthor && rootAuthor !== author) targets.add(rootAuthor);
    }

    for (const target of targets) {
      if (!participants.has(target)) continue;
      interactions.push({
        id: event.id,
        from: author,
        to: target,
        at: event.created_at,
        kind: "message",
        text: firstLine(event.content),
        rootId,
      });
    }
  }

  for (const ask of openAsks) {
    const filer = normalizePubkey(ask.filerPubkey);
    if (!owner || !agentSet.has(filer)) continue;
    interactions.push({
      id: ask.id,
      from: filer,
      to: owner,
      at: ask.createdAt,
      kind: "ask",
      text: firstLine(ask.headline),
      rootId: ask.threadId,
    });
  }

  interactions.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  const edgesByKey = new Map<string, CommGraphEdge>();
  const trafficByPubkey = new Map<string, number>();
  for (const interaction of interactions) {
    const key = `${interaction.from}>${interaction.to}>${interaction.kind}`;
    const existing = edgesByKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastAt = Math.max(existing.lastAt, interaction.at);
    } else {
      edgesByKey.set(key, {
        from: interaction.from,
        to: interaction.to,
        count: 1,
        lastAt: interaction.at,
        kind: interaction.kind,
      });
    }
    for (const pubkey of [interaction.from, interaction.to]) {
      trafficByPubkey.set(pubkey, (trafficByPubkey.get(pubkey) ?? 0) + 1);
    }
  }

  // Busiest agent first so the arc reads outward from the conversation the
  // owner most likely came to look at, with the pubkey as the tiebreak that
  // keeps the order stable across renders.
  const orderedAgents = [...agents].sort(
    (a, b) =>
      (trafficByPubkey.get(b) ?? 0) - (trafficByPubkey.get(a) ?? 0) ||
      a.localeCompare(b),
  );

  const nodes: CommGraphNode[] = [
    ...(owner ? [{ pubkey: owner, kind: "owner" as const }] : []),
    ...orderedAgents.map((pubkey) => ({ pubkey, kind: "agent" as const })),
  ];

  const edges = [...edgesByKey.values()].sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.kind.localeCompare(b.kind),
  );

  return { nodes, edges, interactions };
}

/** Interactions between two pubkeys, either direction, oldest first. */
export function pairInteractions(
  graph: CommGraph,
  a: string,
  b: string,
): readonly CommInteraction[] {
  const left = normalizePubkey(a);
  const right = normalizePubkey(b);
  return graph.interactions.filter(
    (interaction) =>
      (interaction.from === left && interaction.to === right) ||
      (interaction.from === right && interaction.to === left),
  );
}
