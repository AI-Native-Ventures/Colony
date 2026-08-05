import { nip19 } from "nostr-tools";

import type { UserNote } from "@/shared/api/socialTypes";

export function buildNoteShareUri(note: Pick<UserNote, "id" | "pubkey">) {
  return `nostr:${nip19.neventEncode({
    id: note.id,
    author: note.pubkey,
  })}`;
}

export function toggleNoteIdInSet(
  current: ReadonlySet<string>,
  noteId: string,
  enabled: boolean,
) {
  const next = new Set(current);
  if (enabled) {
    next.add(noteId);
  } else {
    next.delete(noteId);
  }
  return next;
}

export function applyReactionState(
  current:
    | Map<string, { count: number; reactedByCurrentUser: boolean }>
    | undefined,
  noteId: string,
  reactedByCurrentUser: boolean,
) {
  const next = new Map(current);
  const previous = next.get(noteId) ?? {
    count: 0,
    reactedByCurrentUser: false,
  };
  const count = Math.max(
    0,
    previous.count +
      (reactedByCurrentUser && !previous.reactedByCurrentUser ? 1 : 0) -
      (!reactedByCurrentUser && previous.reactedByCurrentUser ? 1 : 0),
  );
  next.set(noteId, {
    count,
    reactedByCurrentUser,
  });
  return next;
}

/**
 * Whether this failure means the emoji is already on the note.
 *
 * The user's intent is satisfied either way, so the caller keeps the
 * optimistic "reacted" state instead of showing an error.
 *
 * The relay reports the reaction slot being held three ways, and all three
 * mean the same thing here. `duplicate: reaction already exists` is what
 * relays before the write-contract fix answered; newer ones distinguish
 * re-sending the very event that holds the slot from a different event
 * holding it. The OK frame has no room for the machine-readable `outcome`
 * field that `POST /events` carries, so over WebSocket this is the message
 * we get.
 */
export function isDuplicateReactionError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("duplicate: reaction already exists") ||
    message.includes("identical reaction already applied") ||
    message.includes("superseded by original reaction") ||
    // A legacy `reactions` row with no linked kind:7 event: the relay cannot
    // name a holder, but the emoji is still on the note.
    message.includes("an active reaction already exists")
  );
}
