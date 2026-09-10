import type { ReactNode } from "react";

import type {
  BlockNode,
  BlockOrigin,
  BlockTrust,
} from "@/features/blocks/contracts";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { useMediaProxyPort } from "@/shared/lib/useMediaProxyPort";
import { useRelayOrigin } from "@/shared/lib/useRelayOrigin";
import { MediaCollection } from "@/shared/ui/media-preview/MediaCollection";
import type { MediaCollectionEntry } from "@/shared/ui/media-preview/mediaCollectionModel";

import { BlockPrimitive } from "./primitives";
import {
  inferMediaKind,
  resolveBlockTemplate,
  resolveMedia,
} from "./primitives/resolvers";
import type {
  BlockMediaItem,
  BlockPrimitiveNode,
  ResolvedMedia,
} from "./primitives/types";

const SAMPLE_FILES = new Map<string, readonly [number, number, number, string]>(
  [
    [
      "https://example.com/preview.png",
      [1, 1080, 1080, "A little space for big ideas."],
    ],
    [
      "https://example.com/slide-1.svg",
      [1, 1080, 1080, "A little space for big ideas."],
    ],
    [
      "https://example.com/slide-2.svg",
      [2, 900, 1200, "Good work takes shape."],
    ],
    [
      "https://example.com/slide-3.svg",
      [3, 1440, 900, "Your next chapter starts here."],
    ],
    [
      "https://example.com/tennant-preview.png",
      [1, 1080, 1080, "A little space for big ideas."],
    ],
    [
      "https://example.com/tennant-preview",
      [1, 1080, 1080, "A little space for big ideas."],
    ],
    [
      "https://example.com/tennant-preview-3",
      [3, 1440, 900, "Your next chapter starts here."],
    ],
  ],
);

/** Substitute only known first-party catalogue examples, after media validation. */
export function resolveCatalogSampleMedia(
  entries: readonly ResolvedMedia[],
  origin: BlockOrigin,
  trust: BlockTrust,
): readonly ResolvedMedia[] | null {
  if (origin !== "core" || trust !== "core") return null;
  let substituted = false;
  const result = entries.map((entry) => {
    const sample = entry.item && SAMPLE_FILES.get(entry.item.url);
    if (!sample) return entry;
    substituted = true;
    const [index, width, height, alt] = sample;
    const filename = `launch-0${index}.svg`;
    // A sample is a different file: never retain the placeholder's hash, size,
    // poster, or filename, and download the same bundled bytes being previewed.
    const item: BlockMediaItem = {
      url: `/rich-previews/${filename}`,
      filename,
      kind: "image",
      mime: "image/svg+xml",
      width,
      height,
      alt: `Sample artwork: ${alt}`,
    };
    return { item };
  });
  return substituted ? result : null;
}

function SampleMedia({ entries }: { entries: readonly ResolvedMedia[] }) {
  useMediaProxyPort();
  useRelayOrigin();
  const collection: MediaCollectionEntry[] = entries.map((entry) =>
    entry.item
      ? {
          item: {
            ...entry.item,
            kind: inferMediaKind(entry.item),
            src: rewriteRelayUrl(entry.item.url),
            originalUrl: entry.item.url,
            downloadUrl: entry.item.url,
            poster: entry.item.poster
              ? rewriteRelayUrl(entry.item.poster)
              : undefined,
          },
        }
      : { reason: entry.reason || "Media unavailable." },
  );
  return (
    <fieldset className="w-full min-w-0" data-block-primitive="media">
      <legend className="mb-2 text-xs text-muted-foreground">
        Sample files shown
      </legend>
      <MediaCollection entries={collection} />
    </fieldset>
  );
}

/** Catalogue-only native rendering; signed conversation data is never changed. */
export function ReadonlyBlockPreview({
  data,
  node,
  origin,
  trust,
}: {
  data: unknown;
  node: BlockNode;
  origin: BlockOrigin;
  trust: BlockTrust;
}) {
  const actionEnvironment = {
    trusted: false,
    declaredActionIds: new Set<string>(),
    disabledReason: "Actions are available in the conversation.",
    origin,
  };
  const renderChild = (
    child: BlockPrimitiveNode,
    key: string,
    childData: unknown,
  ): ReactNode => {
    if (child.type === "media" && origin === "core" && trust === "core") {
      const alt =
        resolveBlockTemplate(child.alt, childData, data) || "Block media";
      const samples = resolveCatalogSampleMedia(
        resolveMedia({ ...child, alt }, childData),
        origin,
        trust,
      );
      if (samples) return <SampleMedia entries={samples} key={key} />;
    }
    return (
      <BlockPrimitive
        context={{
          data: childData,
          rootData: data,
          actionEnvironment,
          renderChild,
        }}
        key={key}
        node={child}
      />
    );
  };
  return renderChild(node as BlockPrimitiveNode, "catalog-preview", data);
}
