/** Display metadata keeps original identity separate from a rewritten preview URL. */
export type MediaCollectionItem = {
  src: string;
  originalUrl: string;
  kind: "image" | "video" | "audio" | "file";
  alt?: string;
  filename?: string;
  mime?: string;
  poster?: string;
  thumbnailSrc?: string;
  downloadUrl?: string;
  width?: number;
  height?: number;
  size?: number;
  durationSeconds?: number;
};

/** Invalid entries remain visible at their original position. */
export type MediaCollectionEntry =
  | { item: MediaCollectionItem; reason?: never }
  | { item?: never; reason: string };

/** Repeated URLs are separate attachments, with independent navigation state. */
export function keyMediaCollection(entries: readonly MediaCollectionEntry[]) {
  const occurrences = new Map<string, number>();
  return entries.map((entry) => {
    const identity = JSON.stringify(
      entry.item
        ? [entry.item.kind, entry.item.originalUrl, entry.item.filename]
        : ["unavailable", entry.reason],
    );
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { ...entry, key: `${identity}:${occurrence}` };
  });
}

/** A readable filename without interpreting untrusted metadata as markup. */
export function mediaCollectionLabel(item: MediaCollectionItem): string {
  if (item.filename || item.alt) return item.filename || item.alt || "File";
  try {
    return (
      new URL(item.originalUrl, "https://preview.invalid").pathname
        .split("/")
        .pop() || "File attachment"
    );
  } catch {
    return "File attachment";
  }
}

/** Compact type badge; a filename suffix is descriptive, never a capability claim. */
export function mediaCollectionType(item: MediaCollectionItem): string {
  const extension =
    mediaCollectionLabel(item).match(/\.([a-z0-9]{1,8})$/i)?.[1];
  return (extension || item.kind).toUpperCase();
}
