/**
 * Where a `file` or `image` tab gets its bytes.
 *
 * A tab opened from disk carries a path; one opened from a message attachment
 * carries the relay URL the attachment was uploaded to, because that file has
 * no local copy until someone downloads it.
 */
export type FileSource =
  | { kind: "path"; path: string }
  | { kind: "url"; url: string; name: string; mime: string };

function readString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Read a file path out of a `file` or `image` tab payload. */
export function readFilePath(payload: unknown): string | null {
  return readString(payload, "path");
}

/**
 * Read where a `file` or `image` tab should load from.
 *
 * Returns null for the empty payload a freshly created tab starts with, which
 * is what makes the body offer its file picker.
 */
export function readFileSource(payload: unknown): FileSource | null {
  const path = readFilePath(payload);
  if (path) return { kind: "path", path };

  const url = readString(payload, "url");
  if (!url) return null;
  return {
    kind: "url",
    url,
    name: readString(payload, "name") ?? titleForPath(url),
    mime: readString(payload, "mime") ?? "application/octet-stream",
  };
}

/** A tab title for a path: the file name, never the whole path. */
export function titleForPath(path: string): string {
  const name = path.split(/[\\/]/).pop()?.trim();
  return name && name.length > 0 ? name : "Untitled";
}
