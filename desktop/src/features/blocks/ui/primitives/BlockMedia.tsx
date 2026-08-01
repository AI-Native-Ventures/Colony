import * as React from "react";
import { FileText, ImageOff } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import {
  Attachment,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/shared/ui/attachment";
import { SimpleImageLightbox } from "@/shared/ui/SimpleImageLightbox";
import { VideoPlayer } from "@/shared/ui/VideoPlayer";

import { resolveBlockTemplate, resolveMedia } from "./resolvers";
import type { BlockMediaItem, BlockMediaNode } from "./types";

function ImageMedia({ item }: { item: BlockMediaItem }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        aria-label={`Open image: ${item.alt}`}
        className="group relative overflow-hidden rounded-xl border border-border/60 bg-muted/20 outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setOpen(true)}
        type="button"
      >
        <img
          alt={item.alt}
          className="max-h-96 w-full object-contain transition-transform duration-200 group-hover:scale-[1.01]"
          loading="lazy"
          src={item.url}
        />
      </button>
      <SimpleImageLightbox
        alt={item.alt}
        onOpenChange={setOpen}
        open={open}
        src={item.url}
      />
    </>
  );
}

function FileMedia({ item }: { item: BlockMediaItem }) {
  const label = item.filename || item.alt || "File attachment";
  return (
    <Attachment className="w-full shadow-none">
      <AttachmentMedia>
        <FileText aria-hidden="true" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{label}</AttachmentTitle>
        <AttachmentDescription>
          {item.mime || "External file"}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <span className="text-xs text-muted-foreground">Open</span>
      </AttachmentActions>
      <AttachmentTrigger asChild>
        <a
          aria-label={`Open file: ${label}`}
          href={item.url}
          rel="noreferrer"
          target="_blank"
        >
          <span className="sr-only">{`Open file: ${label}`}</span>
        </a>
      </AttachmentTrigger>
    </Attachment>
  );
}

function MediaItem({ item }: { item: BlockMediaItem }) {
  if (item.kind === "image") return <ImageMedia item={item} />;
  if (item.kind === "video") {
    return (
      <VideoPlayer
        filename={item.filename}
        reviewKey={`block-media:${item.url}`}
        src={item.url}
      />
    );
  }
  return <FileMedia item={item} />;
}

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
  const resolved = resolveMedia(node, data, items);
  const safeItems = resolved.flatMap((entry) =>
    entry.item ? [entry.item] : [],
  );
  const reasons = resolved.flatMap((entry) =>
    entry.reason ? [entry.reason] : [],
  );
  const alt = resolveBlockTemplate(node.alt, data, rootData) || "Block media";

  return (
    <fieldset
      className={cn(
        safeItems.length > 1
          ? "grid grid-cols-1 gap-2 sm:grid-cols-2"
          : "space-y-2",
        className,
      )}
      data-block-primitive="media"
    >
      <legend className="sr-only">{alt}</legend>
      {safeItems.map((item) => (
        <MediaItem item={{ ...item, alt: item.alt || alt }} key={item.url} />
      ))}
      {reasons.map((reason) => (
        <div
          className="flex items-center gap-2 rounded-xl border border-dashed border-border/60 bg-muted/20 px-3 py-4 text-sm text-muted-foreground"
          key={reason}
          role="status"
        >
          <ImageOff aria-hidden="true" className="h-4 w-4 shrink-0" />
          {reason}
        </div>
      ))}
    </fieldset>
  );
}
