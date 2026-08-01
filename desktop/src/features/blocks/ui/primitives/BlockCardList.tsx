import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/shared/ui/carousel";

import type { BlockCardListMode } from "./types";

function itemIdentity(item: unknown): string {
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    for (const property of ["id", "key", "slug", "url", "title"]) {
      const value = record[property];
      if (typeof value === "string" || typeof value === "number") {
        return `${property}:${value}`;
      }
    }
    try {
      return `json:${JSON.stringify(item)}`;
    } catch {
      return "object";
    }
  }
  return `${typeof item}:${String(item)}`;
}

function keyedItems(items: readonly unknown[]) {
  const occurrences = new Map<string, number>();
  return items.map((item, index) => {
    const identity = itemIdentity(item);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { index, item, key: `${identity}:${occurrence}` };
  });
}

export function BlockCardList({
  className,
  items,
  mode = "list",
  renderItem,
}: {
  className?: string;
  items: readonly unknown[];
  mode?: BlockCardListMode;
  renderItem: (item: unknown, index: number) => ReactNode;
}) {
  const entries = keyedItems(items);

  if (items.length === 0) {
    return (
      <p
        className={cn(
          "rounded-xl border border-dashed border-border/60 px-4 py-8 text-center text-sm text-muted-foreground",
          className,
        )}
        data-block-primitive="card-list"
      >
        Nothing to show yet.
      </p>
    );
  }

  if (mode === "carousel") {
    return (
      <Carousel
        aria-label="Block card collection"
        className={cn("px-10", className)}
        data-block-primitive="card-list"
        opts={{ align: "start", loop: false }}
      >
        <CarouselContent>
          {entries.map((entry) => (
            <CarouselItem className="sm:basis-1/2" key={entry.key}>
              {renderItem(entry.item, entry.index)}
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious className="left-0" />
        <CarouselNext className="right-0" />
      </Carousel>
    );
  }

  return (
    <ul
      className={cn(
        mode === "grid"
          ? "grid grid-cols-1 gap-3 sm:grid-cols-2"
          : "flex flex-col gap-2",
        className,
      )}
      data-block-primitive="card-list"
    >
      {entries.map((entry) => (
        <li key={entry.key}>{renderItem(entry.item, entry.index)}</li>
      ))}
    </ul>
  );
}
