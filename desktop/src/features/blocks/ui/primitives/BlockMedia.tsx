import { ImageOff } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { useMediaProxyPort } from "@/shared/lib/useMediaProxyPort";
import { useRelayOrigin } from "@/shared/lib/useRelayOrigin";
import { FileCard } from "@/shared/ui/markdown/FileCard";
import { AudioPlayer, ImagePreview } from "@/shared/ui/media-preview";
import { VideoPlayer } from "@/shared/ui/VideoPlayer";

import { resolveBlockTemplate, resolveMedia } from "./resolvers";
import type { BlockMediaItem, BlockMediaNode } from "./types";

function MediaItem({ item }: { item: BlockMediaItem }) {
  const src = rewriteRelayUrl(item.url);
  if (item.kind === "video") {
    return (
      <VideoPlayer
        downloadUrl={item.url}
        filename={item.filename}
        poster={item.poster ? rewriteRelayUrl(item.poster) : undefined}
        reviewKey={`block-media:${item.url}`}
        src={src}
      />
    );
  }
  if (item.kind === "audio") {
    return (
      <AudioPlayer
        downloadUrl={item.url}
        durationSeconds={item.durationSeconds}
        filename={item.filename || item.alt}
        src={src}
      />
    );
  }
  return (
    <FileCard
      filename={item.filename || item.alt || "File attachment"}
      href={item.url}
      mime={item.mime || ""}
      size={item.size}
    />
  );
}

/** Consecutive images form one carousel; files, audio and video retain their order. */
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
  const resolved = resolveMedia({ ...node, alt }, data, items);
  const groups: Array<
    { images: BlockMediaItem[] } | { item: BlockMediaItem } | { reason: string }
  > = [];
  for (const entry of resolved) {
    if (!entry.item) {
      groups.push({ reason: entry.reason || "Media unavailable." });
      continue;
    }
    const item = { ...entry.item, alt: entry.item.alt || alt };
    const previous = groups.at(-1);
    if (item.kind === "image") {
      if (previous && "images" in previous) previous.images.push(item);
      else groups.push({ images: [item] });
    } else groups.push({ item });
  }
  const occurrences = new Map<string, number>();
  const keyedGroups = groups.map((group) => {
    const identity =
      "images" in group
        ? group.images.map((item) => item.url).join("|")
        : "item" in group
          ? group.item.url
          : group.reason;
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    return { group, key: `${identity}:${occurrence}` };
  });
  return (
    <fieldset
      className={cn("min-w-0 w-full space-y-2", className)}
      data-block-primitive="media"
    >
      <legend className="sr-only">{alt}</legend>
      {keyedGroups.map(({ group, key }) =>
        "images" in group ? (
          <ImagePreview
            items={group.images.map((item) => ({
              src: rewriteRelayUrl(item.url),
              downloadUrl: item.url,
              filename: item.filename,
              alt: item.alt,
              width: item.width,
              height: item.height,
            }))}
            key={key}
          />
        ) : "item" in group ? (
          <MediaItem item={group.item} key={key} />
        ) : (
          <div
            className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 px-3 py-4 text-sm text-muted-foreground"
            key={key}
            role="status"
          >
            <ImageOff aria-hidden="true" className="size-4 shrink-0" />
            {group.reason}
          </div>
        ),
      )}
    </fieldset>
  );
}
