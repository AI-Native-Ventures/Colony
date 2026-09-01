/**
 * Coarse, single-tier duration text: "just now", "5m", "3h", "2d". Used for
 * both "how long ago" (age) and "how long this waited" (escalation,
 * hard-list marker) text, which read naturally with the same tiering, just
 * different surrounding words supplied by the caller.
 */
export function formatDurationCoarse(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * Minute-granularity countdown text: "1h 40m", "40m", "less than a minute".
 * Never shows seconds (spec: "Shown at minute granularity; worst-case error
 * is minutes on a countdown that spans hours"). Negative input (already
 * past the deadline, e.g. a moment of client clock skew before the relay's
 * own default-execution lands) clamps to the same "less than a minute" text
 * rather than a confusing negative countdown.
 */
export function formatCountdownMinutes(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return "less than a minute";
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
