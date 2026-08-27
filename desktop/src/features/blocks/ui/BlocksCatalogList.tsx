import { Blocks } from "lucide-react";

import type { BlockCatalogItem } from "@/features/blocks/blockCatalog";
import { Skeleton } from "@/shared/ui/skeleton";

import { BlockCatalogCard } from "./BlockCatalogCard";

function CatalogLoadingState() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading Blocks"
      className="grid gap-4"
      role="status"
    >
      {[0, 1, 2].map((index) => (
        <div
          className="overflow-hidden rounded-2xl border border-border/60 bg-card/60 p-4"
          key={index}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-72 max-w-full" />
            </div>
            <Skeleton className="h-8 w-28" />
          </div>
          <Skeleton className="mt-5 h-40 w-full rounded-xl" />
        </div>
      ))}
    </div>
  );
}

/**
 * The community's published Blocks, or the state that stands in for them.
 *
 * The list owns no page chrome so it can sit inside the Settings panel that
 * hosts it.
 */
export function BlocksCatalogList({
  error,
  isLoading,
  items,
  onSelect,
}: {
  error: Error | null;
  isLoading: boolean;
  items: readonly BlockCatalogItem[];
  onSelect: (item: BlockCatalogItem) => void;
}) {
  if (isLoading) return <CatalogLoadingState />;

  if (error) {
    return (
      <div
        className="rounded-2xl border border-destructive/25 bg-destructive/5 px-5 py-8"
        role="alert"
      >
        <h2 className="text-base font-semibold text-foreground">
          Blocks could not be loaded
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 px-5 py-12 text-center">
        <Blocks className="mx-auto size-8 text-muted-foreground" />
        <h2 className="mt-3 text-base font-semibold text-foreground">
          No Blocks yet
        </h2>
        <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
          Agents already have Colony's built-in cards to use in a conversation.
          Blocks added to this workspace show up here, and only an owner or an
          admin can add one.
        </p>
      </div>
    );
  }

  return (
    <div className="border-b border-border/50">
      {items.map((item) => (
        <BlockCatalogCard
          item={item}
          key={item.blockAddress}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
