import * as React from "react";
import { ChevronLeft, ChevronRight, ImageOff, Maximize2 } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/dialog";
import { MediaDownloadButton } from "./MediaDownloadButton";
import {
  clampMediaIndex,
  mediaStageRatio,
  mediaSwipeDirection,
} from "./mediaPreviewModel";

/** Original content and download identity for one ordered image or SVG. */
export type MediaPreviewImage = {
  src: string;
  alt: string;
  filename?: string;
  downloadUrl?: string;
  width?: number;
  height?: number;
};

/** One full-width image, or an ordered carousel shared by messages and Blocks. */
export function ImagePreview({
  items,
  title,
  className,
  initialIndex = 0,
}: {
  items: readonly MediaPreviewImage[];
  title?: string;
  className?: string;
  initialIndex?: number;
}) {
  const [index, setIndex] = React.useState(initialIndex);
  const [open, setOpen] = React.useState(false);
  const [failed, setFailed] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [direction, setDirection] = React.useState(0);
  const reducedMotion = useReducedMotion();
  const expandButton = React.useRef<HTMLButtonElement>(null);
  const pointer = React.useRef<{ x: number; y: number } | null>(null);
  const activeIndex = clampMediaIndex(index, items.length);
  const item = items[activeIndex];
  if (!item) return null;
  const label = title ?? item.filename ?? item.alt ?? "Image";
  const filename =
    item.filename ??
    (item.src.toLowerCase().includes(".svg") ? "image.svg" : "image");
  const move = (step: number) => {
    setDirection(step);
    setIndex(clampMediaIndex(activeIndex + step, items.length));
  };
  const controls = (expanded: boolean) => (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {items.length > 1 ? (
          <>
            <Button
              aria-label="Previous image"
              disabled={activeIndex === 0}
              onClick={() => move(-1)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
            </Button>
            <span
              aria-live="polite"
              className="shrink-0 text-xs tabular-nums text-muted-foreground"
              data-testid="media-preview-count"
            >
              {activeIndex + 1} / {items.length}
            </span>
            <Button
              aria-label="Next image"
              disabled={activeIndex === items.length - 1}
              onClick={() => move(1)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ChevronRight aria-hidden="true" className="size-4" />
            </Button>
          </>
        ) : null}
        <span
          className="min-w-0 truncate text-sm text-muted-foreground"
          title={item.filename ?? item.alt}
        >
          {item.filename ?? item.alt}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!expanded ? (
          <Button
            aria-label="Expand image"
            ref={expandButton}
            onClick={() => setOpen(true)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Maximize2 aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
        <MediaDownloadButton
          downloadUrl={item.downloadUrl}
          filename={filename}
          sourceUrl={item.src}
        />
      </div>
    </div>
  );
  const stage = (expanded: boolean) => (
    <div
      className={cn(
        "relative w-full overflow-hidden bg-muted/20",
        expanded ? "h-[min(72vh,55rem)]" : "max-h-[min(65vh,36rem)]",
      )}
      style={{
        ...(expanded
          ? {}
          : {
              aspectRatio: mediaStageRatio(
                items.length,
                item.width,
                item.height,
              ),
            }),
        touchAction: "pan-y",
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "touch")
          pointer.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        const start = pointer.current;
        pointer.current = null;
        if (!start) return;
        const step = mediaSwipeDirection(
          event.clientX - start.x,
          event.clientY - start.y,
        );
        if (step) move(step);
      }}
      onPointerCancel={() => {
        pointer.current = null;
      }}
    >
      {failed.has(item.src) ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"
          role="status"
        >
          <ImageOff aria-hidden="true" className="size-6" />
          <span>Image preview unavailable</span>
        </div>
      ) : (
        <motion.img
          alt={item.alt || item.filename || "Image"}
          className="absolute inset-0 h-full w-full object-contain"
          decoding="async"
          draggable={false}
          animate={{ opacity: 1, x: 0 }}
          initial={
            direction && !reducedMotion
              ? { opacity: 0.6, x: direction * 12 }
              : false
          }
          key={item.src}
          loading="lazy"
          onError={() =>
            setFailed((current) => new Set([...current, item.src]))
          }
          src={item.src}
          transition={{ duration: reducedMotion ? 0 : 0.16 }}
        />
      )}
    </div>
  );
  return (
    <>
      <section
        aria-label={items.length > 1 ? "Image carousel" : "Image preview"}
        aria-roledescription={items.length > 1 ? "carousel" : undefined}
        className={cn(
          "my-2 w-full min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card text-card-foreground",
          className,
        )}
        data-testid="media-image-preview"
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            move(1);
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            move(-1);
          }
        }}
      >
        {stage(false)}
        {controls(false)}
      </section>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="w-[calc(100vw-2rem)] max-w-6xl gap-0 overflow-hidden p-0"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            expandButton.current?.focus();
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              move(-1);
            }
          }}
        >
          <DialogTitle className="truncate px-4 py-3 pr-12 text-base">
            {label}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Expanded image viewer. Use the arrow controls to browse the original
            order.
          </DialogDescription>
          {stage(true)}
          {controls(true)}
        </DialogContent>
      </Dialog>
    </>
  );
}
