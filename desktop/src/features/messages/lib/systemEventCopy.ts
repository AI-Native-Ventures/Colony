/**
 * Copy for channel system events (the "joined", "added by", "changed the
 * topic" captions in the message timeline).
 *
 * These live outside `SystemMessageRow` so the wording is a pure function of
 * the payload and can be asserted directly in tests. Only cases whose caption
 * is plain text belong here — cases that interpolate a profile link build their
 * JSX in the component.
 */

/** Curly quotes, so the caption matches the typography used elsewhere in chat. */
const OPEN_QUOTE = "“";
const CLOSE_QUOTE = "”";

export type ChannelTextField = "topic" | "purpose";

/**
 * Caption for a channel topic or purpose change.
 *
 * A blank value means the field was cleared: the relay reports a clear as a
 * `topic_changed` / `purpose_changed` event carrying an empty string, not as a
 * separate event type. Without this branch the timeline renders `changed the
 * topic to ""`, which reads like the topic was set to two quote marks.
 * Whitespace-only values are treated as cleared for the same reason.
 */
export function describeChannelTextFieldChange(
  field: ChannelTextField,
  value: string | null | undefined,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return `cleared the channel ${field}`;
  }
  return `changed the ${field} to ${OPEN_QUOTE}${trimmed}${CLOSE_QUOTE}`;
}
