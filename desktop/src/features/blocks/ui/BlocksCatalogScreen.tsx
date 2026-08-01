import { Blocks } from "lucide-react";

import type { BlockCatalogItem } from "@/features/blocks/blockCatalog";
import { PageHeader } from "@/shared/ui/PageHeader";
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

export function BlocksCatalogScreen({
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
  return (
    <div
      className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-7 sm:px-6 sm:py-8"
      data-testid="blocks-catalog-page"
    >
      <div className="mx-auto w-full max-w-6xl">
        <PageHeader
          description="The reusable views agents can place inside a conversation. Open one to continue working on it in chat."
          title="Blocks"
        />

        <div className="mt-7">
          {isLoading ? <CatalogLoadingState /> : null}
          {!isLoading && error ? (
            <div
              className="rounded-2xl border border-destructive/25 bg-destructive/5 px-5 py-8"
              role="alert"
            >
              <h2 className="text-base font-semibold text-foreground">
                Blocks could not be loaded
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {error.message}
              </p>
            </div>
          ) : null}
          {!isLoading && !error && items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/70 px-5 py-12 text-center">
              <Blocks className="mx-auto size-8 text-muted-foreground" />
              <h2 className="mt-3 text-base font-semibold text-foreground">
                No Blocks published yet
              </h2>
              <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
                Published Blocks will appear here. Work with an agent in chat to
                create or improve one.
              </p>
            </div>
          ) : null}
          {!isLoading && !error && items.length > 0 ? (
            <div className="grid gap-4">
              {items.map((item) => (
                <BlockCatalogCard
                  item={item}
                  key={item.blockAddress}
                  onSelect={onSelect}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
