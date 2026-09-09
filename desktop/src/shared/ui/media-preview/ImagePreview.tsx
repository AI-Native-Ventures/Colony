import * as React from "react";
import { ChevronLeft, ChevronRight, Maximize2 } from "lucide-react";
import { toast } from "sonner";
import { invokeTauri } from "@/shared/api/tauri";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  MediaContextMenu,
  type MediaContextMenuPosition,
  useDismissMediaContextMenu,
} from "../markdown/MediaContextMenu";
import {
  imageLightboxSourceScopeForTrigger,
  registerImageGalleryItems,
  visibleImageGalleryForTrigger,
} from "../markdown/imageLightbox";
import { dimensionsFromDim, isInsideHiddenSpoiler } from "../markdown/utils";
import { MediaDownloadButton } from "./MediaDownloadButton";
import { ImagePreviewStage } from "./ImagePreviewStage";
import { clampMediaIndex, isBundledPreviewDownload } from "./mediaPreviewModel";

/** Original content and download identity for one ordered image or SVG. */
export type MediaPreviewImage = {
  src: string;
  alt: string;
  filename?: string;
  originalUrl?: string;
  thumbnailSrc?: string;
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
  const [expanded, setExpanded] = React.useState<{
    items: readonly MediaPreviewImage[];
    index: number;
    ownIndices?: (number | undefined)[];
  } | null>(null);
  const [direction, setDirection] = React.useState(0);
  const [menu, setMenu] = React.useState<
    (MediaContextMenuPosition & { item: MediaPreviewImage }) | null
  >(null);
  const expandButton = React.useRef<HTMLButtonElement>(null);
  const imageTrigger = React.useRef<HTMLButtonElement>(null);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const dialog = React.useRef<HTMLDivElement>(null);
  const region = React.useRef<HTMLElement>(null);
  const [hiddenInSpoiler, setHiddenInSpoiler] = React.useState(false);
  React.useLayoutEffect(() => {
    const element = region.current;
    if (!element) return;
    const update = () => setHiddenInSpoiler(isInsideHiddenSpoiler(element));
    update();
    const observer = new MutationObserver(update);
    let ancestor = element.closest(".buzz-spoiler[data-spoiler]");
    while (ancestor) {
      observer.observe(ancestor, {
        attributes: true,
        attributeFilter: ["data-revealed"],
      });
      ancestor =
        ancestor.parentElement?.closest(".buzz-spoiler[data-spoiler]") ?? null;
    }
    return () => observer.disconnect();
  }, []);
  const activeIndex = clampMediaIndex(index, items.length);
  const item = items[activeIndex];
  React.useLayoutEffect(() => {
    const trigger = imageTrigger.current;
    if (!trigger) return;
    trigger.dataset.imageLightboxIndex = String(activeIndex);
    return registerImageGalleryItems(
      trigger,
      items.map((entry) => ({
        alt: entry.alt,
        resolvedSrc: entry.src,
        src: entry.originalUrl ?? entry.downloadUrl ?? entry.src,
        filename: entry.filename,
        downloadUrl: entry.downloadUrl,
        thumbnailSrc: entry.thumbnailSrc,
        dim:
          entry.width && entry.height
            ? `${entry.width}x${entry.height}`
            : undefined,
      })),
    );
  }, [items, activeIndex]);
  const closeMenu = React.useCallback(() => setMenu(null), []);
  useDismissMediaContextMenu(Boolean(menu), closeMenu);
  if (!item) return null;
  const openExpanded = (focusTarget: HTMLElement) => {
    const trigger = imageTrigger.current;
    if (!trigger || isInsideHiddenSpoiler(trigger)) return;
    returnFocus.current = focusTarget;
    const discovered = visibleImageGalleryForTrigger(
      trigger,
      {
        alt: item.alt,
        resolvedSrc: item.src,
        src: item.originalUrl ?? item.src,
      },
      imageLightboxSourceScopeForTrigger(trigger),
    );
    setExpanded(
      discovered.galleryItems
        ? {
            items: discovered.galleryItems.map((entry) => {
              const own =
                entry.carousel?.trigger === trigger
                  ? items[entry.carousel.index]
                  : undefined;
              return (
                own ?? {
                  src: entry.resolvedSrc,
                  alt: entry.alt ?? "Image",
                  originalUrl: entry.src,
                  filename: entry.filename,
                  downloadUrl: entry.downloadUrl,
                  thumbnailSrc: entry.thumbnailSrc,
                  ...dimensionsFromDim(entry.dim),
                }
              );
            }),
            index: discovered.galleryIndex,
            ownIndices: discovered.galleryItems.map((entry) =>
              entry.carousel?.trigger === trigger
                ? entry.carousel.index
                : undefined,
            ),
          }
        : {
            items,
            index: activeIndex,
            ownIndices: items.map((_, position) => position),
          },
    );
    setMenu(null);
  };
  const move = (step: number) => {
    setDirection(step);
    setIndex(clampMediaIndex(activeIndex + step, items.length));
  };
  const moveExpanded = (step: number) => {
    setDirection(step);
    setExpanded((current) =>
      current
        ? {
            ...current,
            index: clampMediaIndex(current.index + step, current.items.length),
          }
        : null,
    );
  };
  const closeExpanded = () => {
    const current = expanded?.items[expanded.index];
    if (current) {
      const matching = expanded?.ownIndices?.[expanded.index];
      if (matching != null && matching < items.length) setIndex(matching);
    }
    setMenu(null);
    setExpanded(null);
  };
  const contextMenu = (event: React.MouseEvent, current: MediaPreviewImage) => {
    event.preventDefault();
    if (isInsideHiddenSpoiler(event.currentTarget)) return;
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    setMenu({ x: event.clientX, y: event.clientY, item: current });
  };
  const imageAction = (
    command: "copy_image_to_clipboard" | "download_image",
    selected: MediaPreviewImage,
  ) => {
    setMenu(null);
    const url = selected.originalUrl ?? selected.downloadUrl ?? selected.src;
    if (command === "download_image" && isBundledPreviewDownload(url)) {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = selected.filename ?? "image";
      anchor.click();
      return;
    }
    void invokeTauri(command, { url })
      .then(() => {
        if (command === "copy_image_to_clipboard")
          toast.success("Copied to clipboard");
      })
      .catch((cause: unknown) =>
        toast.error(
          cause instanceof Error ? cause.message : "Image action failed",
        ),
      );
  };
  const controls = (
    expanded: boolean,
    currentItems: readonly MediaPreviewImage[],
    activeIndex: number,
    item: MediaPreviewImage,
    move: (step: number) => void,
  ) => (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {currentItems.length > 1 ? (
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
              {activeIndex + 1} / {currentItems.length}
            </span>
            <Button
              aria-label="Next image"
              disabled={activeIndex === currentItems.length - 1}
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
            onClick={(event) => openExpanded(event.currentTarget)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Maximize2 aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
        <MediaDownloadButton
          downloadUrl={item.downloadUrl}
          filename={
            item.filename ??
            (item.src.toLowerCase().includes(".svg") ? "image.svg" : "image")
          }
          sourceUrl={item.src}
        />
      </div>
    </div>
  );
  const currentExpanded = expanded?.items[expanded.index];
  const keyboard = (
    event: React.KeyboardEvent,
    navigate: (step: number) => void,
  ) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      navigate(event.key === "ArrowRight" ? 1 : -1);
    }
  };
  const menuContent = menu ? (
    <MediaContextMenu
      dataAttributes={[
        "data-image-context-menu",
        "data-image-lightbox-controls",
      ]}
      portalContainer={expanded ? (dialog.current ?? undefined) : undefined}
      position={menu}
      items={[
        {
          label: "Copy image",
          onSelect: () => imageAction("copy_image_to_clipboard", menu.item),
        },
        {
          label: "Download image",
          onSelect: () => imageAction("download_image", menu.item),
        },
      ]}
    />
  ) : null;
  return (
    <>
      <section
        ref={region}
        aria-hidden={hiddenInSpoiler || undefined}
        inert={hiddenInSpoiler || undefined}
        aria-label={items.length > 1 ? "Image carousel" : "Image preview"}
        aria-roledescription={items.length > 1 ? "carousel" : undefined}
        className={cn(
          "my-2 w-full min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card text-card-foreground",
          className,
        )}
        data-testid="media-image-preview"
        onKeyDown={(event) => keyboard(event, move)}
      >
        <ImagePreviewStage
          key={item.src}
          item={item}
          count={items.length}
          direction={direction}
          triggerRef={imageTrigger}
          hidden={hiddenInSpoiler}
          onExpand={openExpanded}
          onMove={move}
          onContextMenu={(event) => contextMenu(event, item)}
        />
        {controls(false, items, activeIndex, item, move)}
      </section>
      <Dialog
        open={Boolean(expanded)}
        onOpenChange={(open) => {
          if (!open) closeExpanded();
        }}
      >
        <DialogContent
          ref={dialog}
          className="w-[calc(100vw-2rem)] max-w-6xl gap-0 overflow-hidden p-0"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (returnFocus.current?.isConnected
              ? returnFocus.current
              : imageTrigger.current
            )?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (menu) {
              event.preventDefault();
              setMenu(null);
            }
          }}
          onKeyDown={(event) => keyboard(event, moveExpanded)}
        >
          <DialogTitle className="truncate px-4 py-3 pr-12 text-base">
            {title ??
              currentExpanded?.filename ??
              currentExpanded?.alt ??
              "Image"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Expanded image viewer. Use the arrow controls to browse the original
            order.
          </DialogDescription>
          {expanded && currentExpanded ? (
            <>
              <ImagePreviewStage
                key={currentExpanded.src}
                item={currentExpanded}
                count={expanded.items.length}
                direction={direction}
                expanded
                onMove={moveExpanded}
                onContextMenu={(event) => contextMenu(event, currentExpanded)}
              />
              {controls(
                true,
                expanded.items,
                expanded.index,
                currentExpanded,
                moveExpanded,
              )}
              {menuContent}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      {!expanded ? menuContent : null}
    </>
  );
}
