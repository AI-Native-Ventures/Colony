import * as React from "react";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import type {
  MediaCollectionEntry,
  MediaCollectionItem,
} from "../media-preview/mediaCollectionModel";
import { isAudioMedia, isRelayDownloadable, isVideoMedia } from "./mediaEntry";
import type { ImetaLookup } from "./types";
import { dimensionsFromDim, getReactNodeText } from "./utils";

/** Only direct media nodes and metadata-backed attachments join a collection. */
export function markdownCollectionItem(
  child: React.ReactNode,
  imetaByUrl?: ImetaLookup,
  relayOrigin?: string | null,
): MediaCollectionItem | undefined {
  if (
    !React.isValidElement<{
      src?: string;
      href?: string;
      alt?: string;
      children?: React.ReactNode;
      node?: { tagName?: string };
      "data-block-media"?: unknown;
    }>(child)
  )
    return undefined;
  const props = child.props;
  const imageNode =
    child.type === "img" ||
    props.node?.tagName === "img" ||
    props["data-block-media"] != null;
  const src = imageNode ? props.src : props.href;
  if (!src) return undefined;
  const entry = imetaByUrl?.get(src);
  // Do not turn an ordinary hyperlink or a spoiler's nested content into a viewer.
  if (!imageNode && !entry?.m) return undefined;
  const kind = isVideoMedia(src, entry?.m)
    ? "video"
    : isAudioMedia(src, entry?.m)
      ? "audio"
      : imageNode || entry?.m?.startsWith("image/")
        ? "image"
        : "file";
  return {
    src: rewriteRelayUrl(src),
    originalUrl: src,
    kind,
    filename: entry?.filename,
    alt: props.alt || getReactNodeText(props.children) || undefined,
    mime: entry?.m,
    size: entry?.size,
    durationSeconds: entry?.duration,
    thumbnailSrc: entry?.thumb ? rewriteRelayUrl(entry.thumb) : undefined,
    poster:
      entry?.image || entry?.thumb
        ? rewriteRelayUrl(entry.image ?? entry.thumb ?? "")
        : undefined,
    downloadUrl: isRelayDownloadable(src, relayOrigin ?? undefined)
      ? src
      : undefined,
    ...dimensionsFromDim(entry?.dim),
  };
}

function isSpacing(child: React.ReactNode): boolean {
  return (
    (typeof child === "string" && !child.trim()) ||
    (React.isValidElement<{ node?: { tagName?: string } }>(child) &&
      (child.type === "br" || child.props.node?.tagName === "br"))
  );
}

/** Preserve prose and spoiler boundaries, grouping only adjacent attachment runs. */
export function groupMarkdownMedia(
  children: React.ReactNode[],
  resolve: (child: React.ReactNode) => MediaCollectionItem | undefined,
  render: (entries: MediaCollectionEntry[], key: number) => React.ReactNode,
): { children: React.ReactNode[]; grouped: boolean } {
  const result: React.ReactNode[] = [];
  let pending: React.ReactNode[] = [];
  let entries: MediaCollectionEntry[] = [];
  let grouped = false;
  const flush = () => {
    if (entries.length > 1) {
      result.push(render(entries, result.length));
      grouped = true;
    } else result.push(...pending);
    pending = [];
    entries = [];
  };
  for (const child of children) {
    const item = resolve(child);
    if (item) {
      pending.push(child);
      entries.push({ item });
    } else if (entries.length && isSpacing(child)) pending.push(child);
    else {
      flush();
      result.push(child);
    }
  }
  flush();
  return { children: result, grouped };
}
