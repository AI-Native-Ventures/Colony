// desktop/src/features/onboarding/welcomeKickoffContext.ts
/**
 * The founder's own signup context, marked so the timeline can keep it quiet.
 *
 * First run posts two things into Welcome, in this order: the founder's
 * context handoff ("Founder: ... Business: ... First task: ...", built by
 * `buildOnboardingFirstTaskMessage`), and then Scout's reply to it. The
 * handoff is a wall of labels the founder just typed, and it was the first
 * thing they read on landing in their own workspace, with the best copy in the
 * product sitting underneath it.
 *
 * So the handoff carries this marker from the moment it is sent, and the
 * timeline renders a message that has it as one quiet line the founder can
 * expand rather than a full message row. Scout's reply then reads first.
 *
 * The marker travels as a second `["client", ...]` tag beside the delivery
 * marker, because `["client", ...]` is the only tag shape the send command
 * accepts from the app (`append_client_tags` in
 * `desktop/src-tauri/src/events/message_tags.rs` rejects any other prefix).
 * Nothing else keys off it, and a message sent before this existed simply has
 * no marker and renders exactly as it always did.
 */

export const WELCOME_KICKOFF_CONTEXT_MARKER = "colony-kickoff:context";

/** The one line the timeline shows in place of the wall of labels. */
export const WELCOME_KICKOFF_CONTEXT_SUMMARY =
  "Your signup details, sent to Scout";

export function welcomeKickoffContextClientTag(): string[] {
  return ["client", WELCOME_KICKOFF_CONTEXT_MARKER];
}

export function isWelcomeKickoffContextMessage(
  tags?: readonly (readonly string[])[] | null,
): boolean {
  return (tags ?? []).some(
    (tag) =>
      tag.length >= 2 &&
      tag[0] === "client" &&
      tag[1] === WELCOME_KICKOFF_CONTEXT_MARKER,
  );
}
