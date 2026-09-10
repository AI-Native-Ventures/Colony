import { cn } from "@/shared/lib/cn";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { useMediaProxyPort } from "@/shared/lib/useMediaProxyPort";
import { useRelayOrigin } from "@/shared/lib/useRelayOrigin";
import { MediaCollection } from "@/shared/ui/media-preview/MediaCollection";
import type { MediaCollectionEntry } from "@/shared/ui/media-preview/mediaCollectionModel";
import {
  inferMediaKind,
  resolveBlockTemplate,
  resolveMedia,
} from "./resolvers";
import type { BlockMediaItem, BlockMediaNode } from "./types";

/** Preserve authored order, including unavailable entries, with one active viewer. */
export function BlockMedia({
  className,
  data,
  items,
  node,
  rootData,
}: {
  className?: string;
  data: unknown;
  items?: readonly BlockMediaItem[];
  node: BlockMediaNode;
  rootData?: unknown;
}) {
  useMediaProxyPort();
  useRelayOrigin();
  const alt = resolveBlockTemplate(node.alt, data, rootData) || "Block media";
  const entries: MediaCollectionEntry[] = resolveMedia(
    { ...node, alt },
    data,
    items,
  ).map((entry) =>
    entry.item
      ? {
          item: {
            ...entry.item,
            kind: inferMediaKind(entry.item),
            src: rewriteRelayUrl(entry.item.url),
            originalUrl: entry.item.url,
            downloadUrl: entry.item.url,
            alt: entry.item.alt || alt,
            poster: entry.item.poster
              ? rewriteRelayUrl(entry.item.poster)
              : undefined,
          },
        }
      : { reason: entry.reason || "Media unavailable." },
  );
  return (
    <fieldset
      className={cn("w-full min-w-0", className)}
      data-block-primitive="media"
    >
      <legend className="sr-only">{alt}</legend>
      <MediaCollection entries={entries} />
    </fieldset>
  );
}
