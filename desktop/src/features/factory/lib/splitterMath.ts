/**
 * Splitter drag math for Factory canvas.
 */
import { MIN_SPLIT_SIZE } from "./tileTree";

export function resizePair(
  startSizes: ReadonlyArray<number>,
  splitIndex: number,
  delta: number,
): ReadonlyArray<number> {
  // splitIndex is the index of the right/bottom child of the split.
  // The split is between splitIndex - 1 and splitIndex.
  const leftIndex = splitIndex - 1;
  const rightIndex = splitIndex;

  if (leftIndex < 0 || rightIndex >= startSizes.length) return startSizes;

  const pairTotal = startSizes[leftIndex] + startSizes[rightIndex];
  const nextLeft = Math.max(MIN_SPLIT_SIZE, startSizes[leftIndex] + delta);
  const nextRight = pairTotal - nextLeft;
  const clampedRight = Math.max(MIN_SPLIT_SIZE, nextRight);
  const adjustedLeft = pairTotal - clampedRight;
  const finalLeft = Math.max(MIN_SPLIT_SIZE, adjustedLeft);
  const finalRight = pairTotal - finalLeft;

  const result = [...startSizes];
  result[leftIndex] = finalLeft;
  result[rightIndex] = finalRight;
  return result;
}
