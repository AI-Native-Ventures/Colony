/** Read a file path out of a `file` or `image` tab payload. */
export function readFilePath(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const path = (payload as Record<string, unknown>).path;
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A tab title for a path: the file name, never the whole path. */
export function titleForPath(path: string): string {
  const name = path.split(/[\\/]/).pop()?.trim();
  return name && name.length > 0 ? name : "Untitled";
}
