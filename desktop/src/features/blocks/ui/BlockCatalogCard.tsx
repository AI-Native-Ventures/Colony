import { ChevronRight, TriangleAlert } from "lucide-react";

import {
  type BlockCatalogItem,
  parseBlockWorkshopDestination,
} from "@/features/blocks/blockCatalog";
import { Button } from "@/shared/ui/button";

import { ReadonlyBlockPreview } from "./ReadonlyBlockPreview";

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
        <p className="break-words text-xs text-muted-foreground">
          Requires {permissionLabels.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

/** One full native preview with its publisher concerns and conversation handoff. */
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
      className="@container min-w-0 space-y-6 rounded-xl border border-border bg-card p-5 text-card-foreground @sm/catalog:p-6"
      data-block-catalog-handle={item.handle}
      data-testid={`block-catalog-card-${item.handle}`}
    >
      <div className="min-w-0">
        <h2 className="break-words text-xl font-semibold tracking-tight text-foreground">
          {item.name}
        </h2>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <p className="break-all font-mono text-xs text-muted-foreground">
            @{item.handle}
          </p>
          {item.status === "deprecated" ? (
            <span className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
              Deprecated
            </span>
          ) : null}
        </div>
        <p className="mt-3 break-words text-sm leading-relaxed text-muted-foreground">
          {item.summary}
        </p>
        <Button
          className="mt-4 h-auto p-0 text-sm font-medium text-foreground"
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

      <figure
        aria-label={`${item.name} read-only preview`}
        className="min-w-0 rounded-lg bg-background p-3 @sm/catalog:p-5"
      >
        <figcaption className="sr-only">
          {item.name} read-only preview
        </figcaption>
        <ReadonlyBlockPreview
          data={item.preview}
          node={manifest.tree}
          origin={item.origin}
          trust={trust}
        />
      </figure>
    </article>
  );
}
