import * as React from "react";
import {
  classifyChildren,
  hasBlockMedia,
  isImageOnlyParagraph,
} from "../markdownUtils";
import { resolveFileCard } from "../markdownFileCard";
import { MediaCollection } from "../media-preview/MediaCollection";
import {
  groupMarkdownMedia,
  markdownCollectionItem,
} from "./mediaCollectionChildren";
import { VideoReviewMarkdownContext } from "./MarkdownVideoPlayer";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { AudioPlayer, ImagePreview } from "@/shared/ui/media-preview";
import { isRelayDownloadable } from "./mediaEntry";
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

/** Related media children become one ordered collection. */
export function ImageMosaic({ children }: { children: React.ReactNode[] }) {
  const { imetaByUrl, relayOrigin } = useMarkdownRuntime();
  const reviewContext = React.useContext(VideoReviewMarkdownContext);
  const entries = [];
  for (const child of children) {
    const item = markdownCollectionItem(child, imetaByUrl, relayOrigin);
    if (!item) return <div className="space-y-2">{children}</div>;
    entries.push({ item });
  }
  return <MediaCollection entries={entries} reviewContext={reviewContext} />;
}

/** Promote paragraphs containing rich attachments to valid block markup. */
export function MarkdownMediaParagraph({
  children,
}: {
  children?: React.ReactNode;
}) {
  const { imetaByUrl, relayOrigin } = useMarkdownRuntime();
  const reviewContext = React.useContext(VideoReviewMarkdownContext);
  const childArray = React.Children.toArray(children);
  const { imageChildren } = classifyChildren(childArray);
  if (isImageOnlyParagraph(childArray))
    return <ImageMosaic>{imageChildren}</ImageMosaic>;
  const grouped = groupMarkdownMedia(
    childArray,
    (child) => markdownCollectionItem(child, imetaByUrl, relayOrigin),
    (entries, key) => (
      <MediaCollection
        key={key}
        entries={entries}
        reviewContext={reviewContext}
      />
    ),
  );
  if (grouped.grouped) return <div>{grouped.children}</div>;
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
    return Boolean(card) || React.Children.toArray(nested).some(hasDocument);
  };
  return hasBlockMedia(childArray) || childArray.some(hasDocument) ? (
    <div>{children}</div>
  ) : (
    <p>{children}</p>
  );
}
