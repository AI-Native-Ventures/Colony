/**
 * Returns the label for the thread-level read-state toggle.
 *
 * A thread is unread when its root or any visible/collapsed descendant has an
 * unread marker. The panel supplies that already-derived boolean; this helper
 * keeps the user-facing copy and action choice in one tested place.
 */
export function getThreadReadStateToggleLabel(
  isUnread: boolean,
): "Mark thread as read" | "Mark thread as unread" {
  return isUnread ? "Mark thread as read" : "Mark thread as unread";
}

export function getThreadReadStateAction(isUnread: boolean): "read" | "unread" {
  return isUnread ? "read" : "unread";
}
