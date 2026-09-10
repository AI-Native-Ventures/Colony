import { Blocks, Search, TriangleAlert } from "lucide-react";
import { useId, useMemo, useState } from "react";

import type { BlockCatalogItem } from "@/features/blocks/blockCatalog";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Skeleton } from "@/shared/ui/skeleton";

import { BlockCatalogCard } from "./BlockCatalogCard";
import {
  type BlockCatalogCategory,
  blockCatalogCategory,
  filterBlockCatalog,
} from "./blockCatalogPresentation";

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "composites", label: "Composed" },
  { id: "primitives", label: "Foundation" },
  { id: "custom", label: "Custom" },
] as const;

function CatalogLoadingState() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading Blocks"
      className="grid gap-4"
      role="status"
    >
      <Skeleton className="h-10 w-full max-w-sm" />
      <div className="grid grid-cols-2 gap-3">
        {[0, 1, 2, 3].map((index) => (
          <div
            className="space-y-3 rounded-xl border border-border bg-card p-4"
            key={index}
          >
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Metadata-only tile; document and media viewers mount only in the selection. */
function CatalogTile({
  item,
  selected,
  onSelect,
  previewId,
}: {
  item: BlockCatalogItem;
  selected: boolean;
  onSelect: () => void;
  previewId: string;
}) {
  return (
    <button
      aria-controls={previewId}
      aria-label={`Preview ${item.name}${item.manifestRecord.trust === "untrusted" ? ", untrusted publisher" : ""}`}
      aria-pressed={selected}
      className="flex h-full w-full min-w-0 flex-col items-start rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary/60 aria-pressed:bg-primary/5"
      data-testid={`select-block-preview-${item.handle}`}
      onClick={onSelect}
      type="button"
    >
      <span className="flex w-full min-w-0 items-start justify-between gap-3">
        <span className="break-words text-sm font-semibold text-foreground">
          {item.name}
        </span>
        {item.manifestRecord.trust === "untrusted" ? (
          <TriangleAlert
            aria-label="Untrusted publisher"
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />
        ) : null}
      </span>
      <span className="mt-1 break-all font-mono text-xs text-muted-foreground">
        @{item.handle}
      </span>
      <span className="mt-3 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
        {item.summary}
      </span>
      {item.status === "deprecated" ? (
        <span className="mt-3 text-xs text-muted-foreground">Deprecated</span>
      ) : null}
    </button>
  );
}

/** Search the published catalog while mounting only the selected native preview. */
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
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<BlockCatalogCategory>("all");
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const previewId = useId();
  const searchId = useId();
  const filtered = useMemo(
    () => filterBlockCatalog(items, query, category),
    [items, query, category],
  );
  const selected =
    filtered.find((item) => item.blockAddress === selectedAddress) ??
    filtered[0];
  const counts = useMemo(() => {
    const result = {
      all: items.length,
      composites: 0,
      primitives: 0,
      custom: 0,
    };
    for (const item of items) result[blockCatalogCategory(item)] += 1;
    return result;
  }, [items]);

  if (isLoading) return <CatalogLoadingState />;
  if (error) {
    return (
      <div
        className="rounded-xl border border-destructive/25 bg-destructive/5 px-5 py-8"
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
      <div className="rounded-xl border border-dashed border-border px-5 py-12 text-center">
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
    <div
      className="@container/catalog min-w-0 space-y-6"
      data-testid="blocks-workspace-catalog"
    >
      <div className="space-y-4">
        <div className="relative max-w-md">
          <label className="sr-only" htmlFor={searchId}>
            Search Blocks
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground"
          />
          <Input
            className="h-10 pl-9"
            id={searchId}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Blocks"
            type="search"
            value={query}
          />
        </div>
        <fieldset
          aria-label="Block categories"
          className="flex min-w-0 flex-wrap gap-2"
        >
          {CATEGORIES.map(({ id, label }) => (
            <Button
              aria-pressed={category === id}
              className="h-auto min-h-9 gap-2 whitespace-normal text-sm"
              key={id}
              onClick={() => setCategory(id)}
              size="sm"
              type="button"
              variant={category === id ? "secondary" : "ghost"}
            >
              {label}{" "}
              <span className="text-xs tabular-nums text-muted-foreground">
                {counts[id]}
              </span>
            </Button>
          ))}
        </fieldset>
      </div>
      <div className="grid min-w-0 gap-6 @4xl/catalog:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="min-w-0 space-y-3">
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {filtered.length} {filtered.length === 1 ? "Block" : "Blocks"}
            {query.trim() ? ` matching “${query.trim()}”` : " available"}
          </p>
          {filtered.length ? (
            <ul
              aria-label="Available Blocks"
              className="grid max-h-80 min-w-0 grid-cols-1 gap-3 overflow-y-auto rounded-sm p-1 @sm/catalog:grid-cols-2 @4xl/catalog:max-h-[36rem] @4xl/catalog:grid-cols-1"
            >
              {filtered.map((item) => (
                <li className="min-w-0" key={item.blockAddress}>
                  <CatalogTile
                    item={item}
                    onSelect={() => setSelectedAddress(item.blockAddress)}
                    previewId={previewId}
                    selected={item.blockAddress === selected?.blockAddress}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-xl border border-dashed border-border p-5">
              <p className="text-sm text-muted-foreground">
                No Blocks match these filters.
              </p>
              <Button
                className="mt-3"
                onClick={() => {
                  setQuery("");
                  setCategory("all");
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Clear filters
              </Button>
            </div>
          )}
        </div>
        <section
          aria-label="Selected Block preview"
          className="min-w-0 space-y-3 self-start"
          id={previewId}
        >
          {selected ? (
            <>
              <p className="text-xs text-muted-foreground">Read-only preview</p>
              <BlockCatalogCard
                item={selected}
                key={`${selected.blockAddress}:${selected.manifestId}`}
                onSelect={onSelect}
              />
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
