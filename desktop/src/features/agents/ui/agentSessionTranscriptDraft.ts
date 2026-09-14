import type { TranscriptItem } from "./agentSessionTypes";
import type {
  TranscriptDraft,
  TranscriptState,
} from "./agentSessionTranscript";

/**
 * Draft bookkeeping for the transcript fold: a copy-on-write view over the
 * previous state so an unchanged fold returns the same references.
 *
 * Split out of `agentSessionTranscript.ts` for the desktop file-size ratchet.
 */
export function draftFrom(state: TranscriptState): TranscriptDraft {
  return {
    items: state.items,
    itemsById: state.itemsById,
    activeMessageKey: state.activeMessageKey,
    sealedKeys: state.sealedKeys,
    triggeringEventIdsByTurn: state.triggeringEventIdsByTurn,
    pendingPermissions: state.pendingPermissions,
    continuationSeq: state.continuationSeq,
    latestSessionId: state.latestSessionId,
    changed: false,
  };
}

/** Lazily copy items + itemsById on first mutation so callers get new refs. */
export function ensureMutable(d: TranscriptDraft) {
  if (!d.changed) {
    d.items = [...d.items];
    d.itemsById = new Map(d.itemsById);
    d.changed = true;
  }
}

export function replaceItem(
  d: TranscriptDraft,
  id: string,
  updated: TranscriptItem,
) {
  ensureMutable(d);
  const idx = d.items.findIndex((it) => it.id === id);
  if (idx !== -1) {
    d.items[idx] = updated;
  }
  d.itemsById.set(id, updated);
}

export function pushItem(d: TranscriptDraft, item: TranscriptItem) {
  ensureMutable(d);
  d.items.push(item);
  d.itemsById.set(item.id, item);
}

export function sealOpenMessages(d: TranscriptDraft) {
  let copied = false;
  for (const [, currentKey] of d.activeMessageKey) {
    if (!d.sealedKeys.has(currentKey)) {
      if (!copied) {
        d.sealedKeys = new Set(d.sealedKeys);
        copied = true;
      }
      d.sealedKeys.add(currentKey);
    }
  }
}

export function turnMapKey(
  channelKey: string,
  turnKey: string | number | null,
) {
  return `${channelKey}:${turnKey ?? "unknown"}`;
}
