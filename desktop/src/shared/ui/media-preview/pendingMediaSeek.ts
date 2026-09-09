/** Apply a queued restore only once the media element has a usable timeline. */
export function applyPendingMediaSeek(
  media: Pick<HTMLMediaElement, "readyState" | "currentTime">,
  seconds: number | null,
): boolean {
  // HAVE_NOTHING has no timeline yet; keep the request for loadedmetadata.
  if (seconds === null || media.readyState < 1) return false;
  media.currentTime = seconds;
  return true;
}
