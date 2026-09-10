import { ChevronRight, TriangleAlert } from "lucide-react";

import type { BlockNode } from "@/features/blocks/contracts";
import {
  type BlockCatalogItem,
  parseBlockWorkshopDestination,
} from "@/features/blocks/blockCatalog";
import { InlineFilePreview } from "@/shared/ui/file-preview/InlineFilePreview";
import { ImagePreview } from "@/shared/ui/media-preview";
import { Button } from "@/shared/ui/button";

import { BlockPrimitive } from "./primitives";
import type { BlockPrimitiveNode } from "./primitives";

const PREVIEW_ENVIRONMENT = {
  origin: "core" as const,
  trusted: false,
  declaredActionIds: new Set<string>(),
  disabledReason: "Actions are available in the conversation.",
};

function ReadonlyBlockPreview({
  data,
  node,
}: {
  data: unknown;
  node: BlockNode;
}) {
  return (
    <BlockPrimitive
      context={{ data, actionEnvironment: PREVIEW_ENVIRONMENT }}
      node={node as BlockPrimitiveNode}
    />
  );
}

/**
 * The shelf shows a block, not a dossier. Only the two facts that could change
 * someone's mind about opening it are surfaced: that the publisher is untrusted,
 * and any capability the block asks for. Version, usage, publisher key,
 * compatible clients and primitive contracts belong in the workshop, where a
 * person is inspecting one block rather than scanning for one.
 */
function BlockConcerns({
  permissionLabels,
  untrusted,
}: {
  permissionLabels: readonly string[];
  untrusted: boolean;
}) {
  if (!untrusted && permissionLabels.length === 0) return null;
  return (
    <div className="mt-4 space-y-1.5">
      {untrusted ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          Untrusted publisher
        </p>
      ) : null}
      {permissionLabels.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Requires {permissionLabels.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

export function BlockCatalogCard({
  item,
  onSelect,
}: {
  item: BlockCatalogItem;
  onSelect: (item: BlockCatalogItem) => void;
}) {
  const { manifest, trust } = item.manifestRecord;
  const permissionLabels = item.permissions.map(
    (permission) => permission.capability,
  );
  const hasWorkshop = parseBlockWorkshopDestination(item.workshop) !== null;

  return (
    <article
      className="@container min-w-0 space-y-5 rounded-xl border border-border bg-card p-5 text-card-foreground"
      data-block-catalog-handle={item.handle}
      data-testid={`block-catalog-card-${item.handle}`}
    >
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          {item.name}
        </h2>
        <p className="mt-0.5 font-mono text-xs text-primary">@{item.handle}</p>
        <p className="mt-2.5 max-w-[44ch] text-sm leading-5 text-muted-foreground">
          {item.summary}
        </p>
        <Button
          className="mt-4 h-auto p-0 font-medium text-foreground"
          data-testid={`open-block-workshop-${item.handle}`}
          onClick={() => onSelect(item)}
          size="sm"
          type="button"
          variant="link"
        >
          {hasWorkshop ? "Open workshop" : "Work in chat"}
          <ChevronRight aria-hidden="true" className="size-3.5" />
        </Button>
        <BlockConcerns
          permissionLabels={permissionLabels}
          untrusted={trust === "untrusted"}
        />
      </div>

      <figure className="min-w-0 rounded-lg bg-background p-3">
        <figcaption className="sr-only">
          {item.name} read-only preview
        </figcaption>
        {trust === "core" && item.handle === "media" ? (
          <ImagePreview
            items={[
              {
                src: "/rich-previews/launch-01.svg",
                downloadUrl: "/rich-previews/launch-01.svg",
                filename: "launch-01.svg",
                alt: "Launch campaign preview",
                width: 1080,
                height: 1080,
              },
            ]}
          />
        ) : trust === "core" && item.handle === "artifact" ? (
          <InlineFilePreview
            href="/rich-previews/service-report.pdf"
            filename="service-report.pdf"
          />
        ) : (
          <ReadonlyBlockPreview data={item.preview} node={manifest.tree} />
        )}
      </figure>
    </article>
  );
}
