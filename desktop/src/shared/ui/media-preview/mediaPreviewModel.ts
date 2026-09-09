/** Clamp navigation when a collection changes or a caller supplies an old index. */
export function clampMediaIndex(index: number, count: number): number {
  return Math.min(
    Math.max(0, Math.trunc(Number.isFinite(index) ? index : 0)),
    Math.max(0, count - 1),
  );
}

/** A horizontal swipe must be intentional and larger than vertical scrolling. */
export function mediaSwipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy) * 1.3) return 0;
  return dx < 0 ? 1 : -1;
}

/** Human-readable media timing without invalid or negative values. */
export function formatMediaTime(seconds: number): string {
  const total = Math.floor(Number.isFinite(seconds) ? Math.max(0, seconds) : 0);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** Only app-owned sample files can use a relative browser download. */
export function isBundledPreviewDownload(url: string): boolean {
  return /^\/rich-previews\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(url);
}

/** Singles retain their complete intrinsic ratio; carousels reserve a stable frame. */
export function mediaStageRatio(
  count: number,
  width?: number,
  height?: number,
): number {
  if (
    count === 1 &&
    width &&
    height &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  ) {
    return width / height;
  }
  return 4 / 3;
}
