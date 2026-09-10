import * as React from "react";
import { supportsInlineFilePreview } from "@/shared/ui/file-preview/filePreviewModel";
import {
  classifyChildren,
  hasBlockMedia,
  isImageOnlyParagraph,
} from "../markdownUtils";
import { resolveFileCard } from "../markdownFileCard";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import {
  AudioPlayer,
  ImagePreview,
  type MediaPreviewImage,
} from "@/shared/ui/media-preview";
import { isAudioMedia, isRelayDownloadable, isVideoMedia } from "./mediaEntry";
import { useMarkdownRuntime } from "./runtimeContext";
import { dimensionsFromDim, getReactNodeText } from "./utils";

/** Resolve original audio metadata through the per-message runtime. */
export function MarkdownAudioPlayer({
  src,
  resolvedSrc,
  alt,
}: {
  src: string;
  resolvedSrc: string;
  alt?: string;
}) {
  const { imetaByUrl, relayOrigin } = useMarkdownRuntime();
  const entry = imetaByUrl?.get(src);
  return (
    <AudioPlayer
      src={resolvedSrc}
      filename={entry?.filename ?? alt ?? "Audio"}
      durationSeconds={entry?.duration}
      downloadUrl={
        isRelayDownloadable(src, relayOrigin ?? undefined) ? src : undefined
      }
    />
  );
}

/** Use shared viewing outside spoilers while preserving the existing spoiler surface. */
export function MarkdownImageSurface({
  alt,
  dim,
  resolvedSrc,
  src,
  spoilerImage,
}: {
  alt?: string;
  dim?: string;
  resolvedSrc?: string;
  src?: string;
  spoilerImage: React.ReactNode;
}) {
  const holder = React.useRef<HTMLSpanElement>(null);
  const [inSpoiler, setInSpoiler] = React.useState<boolean | null>(null);
  const { imetaByUrl, relayOrigin } = useMarkdownRuntime();
  React.useLayoutEffect(() => {
    setInSpoiler(
      Boolean(holder.current?.closest(".buzz-spoiler[data-spoiler]")),
    );
  }, []);
  const dimensions = dimensionsFromDim(dim);
  const entry = src ? imetaByUrl?.get(src) : undefined;
  return (
    <span className="block w-full min-w-0" ref={holder}>
      {inSpoiler == null ? null : inSpoiler ? (
        spoilerImage
      ) : resolvedSrc ? (
        <ImagePreview
          items={[
            {
              src: resolvedSrc,
              originalUrl: src,
              thumbnailSrc: entry?.thumb
                ? rewriteRelayUrl(entry.thumb)
                : undefined,
              alt: alt ?? "Image",
              filename: entry?.filename,
              downloadUrl:
                src && isRelayDownloadable(src, relayOrigin ?? undefined)
                  ? src
                  : undefined,
              ...dimensions,
            },
          ]}
        />
      ) : null}
    </span>
  );
}

/** Related image children become one ordered carousel; mixed media retain their players. */
export function ImageMosaic({ children }: { children: React.ReactNode[] }) {
  const { imetaByUrl, relayOrigin } = useMarkdownRuntime();
  const items: MediaPreviewImage[] = [];
  for (const child of children) {
    if (
      !React.isValidElement<{ src?: string; alt?: string }>(child) ||
      !child.props.src
    )
      return <div className="space-y-2">{children}</div>;
    const { src, alt } = child.props;
    const entry = imetaByUrl?.get(src);
    // Related images share a carousel; mixed video/image output keeps its players.
    if (isVideoMedia(src, entry?.m) || isAudioMedia(src, entry?.m))
      return <div className="space-y-2">{children}</div>;
    items.push({
      src: rewriteRelayUrl(src),
      originalUrl: src,
      thumbnailSrc: entry?.thumb ? rewriteRelayUrl(entry.thumb) : undefined,
      alt: alt ?? "Image",
      filename: entry?.filename,
      downloadUrl: isRelayDownloadable(src, relayOrigin ?? undefined)
        ? src
        : undefined,
      ...dimensionsFromDim(entry?.dim),
    });
  }
  return <ImagePreview items={items} />;
}

/** Promote paragraphs containing rich attachments to valid block markup. */
export function MarkdownMediaParagraph({
  children,
}: {
  children?: React.ReactNode;
}) {
  const { imetaByUrl } = useMarkdownRuntime();
  const childArray = React.Children.toArray(children);
  const { imageChildren } = classifyChildren(childArray);
  if (isImageOnlyParagraph(childArray))
    return <ImageMosaic>{imageChildren}</ImageMosaic>;
  const hasDocument = (child: React.ReactNode): boolean => {
    if (
      !React.isValidElement<{ href?: string; children?: React.ReactNode }>(
        child,
      )
    )
      return false;
    const { href, children: nested } = child.props;
    const card = resolveFileCard(
      href ? imetaByUrl?.get(href) : undefined,
      href,
      getReactNodeText(nested),
    );
    return (
      Boolean(card && supportsInlineFilePreview(card.filename, card.mime)) ||
      React.Children.toArray(nested).some(hasDocument)
    );
  };
  return hasBlockMedia(childArray) || childArray.some(hasDocument) ? (
    <div>{children}</div>
  ) : (
    <p>{children}</p>
  );
}
