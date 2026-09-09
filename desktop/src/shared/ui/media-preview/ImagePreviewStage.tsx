import * as React from "react";
import { ImageOff } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { ProgressiveImage } from "../markdown/ProgressiveImage";
import { rememberDecodedImageDimensions } from "../markdown/utils";
import { mediaStageRatio, mediaSwipeDirection } from "./mediaPreviewModel";
import type { MediaPreviewImage } from "./ImagePreview";

/** A contained, active-only image surface with thumbnail-first loading. */
export function ImagePreviewStage({
  item,
  count,
  expanded,
  hidden,
  direction,
  triggerRef,
  onExpand,
  onMove,
  onContextMenu,
}: {
  item: MediaPreviewImage;
  count: number;
  expanded?: boolean;
  hidden?: boolean;
  direction: number;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  onExpand?: (trigger: HTMLButtonElement) => void;
  onMove: (step: number) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const [failed, setFailed] = React.useState(false);
  const [intrinsic, setIntrinsic] = React.useState<{
    width: number;
    height: number;
  } | null>(null);
  const imageRef = React.useRef<HTMLImageElement>(null);
  const thumbRef = React.useRef<HTMLImageElement>(null);
  const pointer = React.useRef<{ x: number; y: number } | null>(null);
  const swiped = React.useRef(false);
  const reducedMotion = useReducedMotion();
  const dimensions = intrinsic ?? item;
  const width = dimensions.width ?? 4;
  const height = dimensions.height ?? 3;
  const updateDimensions = React.useCallback(
    (image: HTMLImageElement) => {
      const { naturalWidth: width, naturalHeight: height } = image;
      if (width <= 0 || height <= 0) return;
      rememberDecodedImageDimensions(item.src, width, height);
      setIntrinsic((current) =>
        current?.width === width && current.height === height
          ? current
          : { width, height },
      );
    },
    [item.src],
  );
  const surface = (
    <>
      {failed ? (
        <span
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"
          role="status"
        >
          <ImageOff aria-hidden="true" className="size-6" />
          <span>Image preview unavailable</span>
        </span>
      ) : (
        <motion.span
          className="absolute inset-0 block"
          animate={{ opacity: 1, x: 0 }}
          initial={
            direction && !reducedMotion
              ? { opacity: 0.6, x: direction * 12 }
              : false
          }
          transition={{ duration: reducedMotion ? 0 : 0.16 }}
        >
          <ProgressiveImage
            alt={item.alt || item.filename || "Image"}
            fillStage
            fullImageRef={imageRef}
            thumbnailRef={thumbRef}
            height={height}
            width={width}
            onFullLoad={updateDimensions}
            onThumbnailLoad={updateDimensions}
            onError={() => setFailed(true)}
            resolvedSrc={item.src}
            thumbSrc={expanded ? undefined : item.thumbnailSrc}
            showSpoilerSize={false}
            style={undefined}
          />
        </motion.span>
      )}
    </>
  );
  const shared = {
    className: cn(
      "relative block w-full overflow-hidden bg-muted/20",
      expanded ? "h-[min(72vh,55rem)]" : count > 1 && "max-h-[min(65vh,36rem)]",
    ),
    style: {
      ...(expanded
        ? {}
        : { aspectRatio: mediaStageRatio(count, width, height) }),
      touchAction: "pan-y",
    } as React.CSSProperties,
    onContextMenuCapture: onContextMenu,
    onPointerDown: (event: React.PointerEvent) => {
      swiped.current = false;
      if (event.pointerType === "touch")
        pointer.current = { x: event.clientX, y: event.clientY };
    },
    onPointerUp: (event: React.PointerEvent) => {
      const start = pointer.current;
      pointer.current = null;
      if (!start) return;
      const step = mediaSwipeDirection(
        event.clientX - start.x,
        event.clientY - start.y,
      );
      if (step) {
        swiped.current = true;
        onMove(step);
      }
    },
    onPointerCancel: () => {
      pointer.current = null;
    },
  };
  return expanded ? (
    <div {...shared} data-image-lightbox-frame="">
      {surface}
    </div>
  ) : (
    <button
      {...shared}
      type="button"
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      ref={triggerRef}
      aria-label={`Zoom image: ${item.alt || item.filename || "Image"}`}
      data-testid="message-image-lightbox-trigger"
      data-image-lightbox-trigger=""
      data-image-lightbox-resolved-src={item.src}
      data-image-lightbox-src={item.originalUrl ?? item.downloadUrl ?? item.src}
      data-image-lightbox-alt={item.alt}
      data-image-lightbox-dim={`${width}x${height}`}
      onClick={(event) => {
        if (!swiped.current) onExpand?.(event.currentTarget);
      }}
    >
      {surface}
    </button>
  );
}
