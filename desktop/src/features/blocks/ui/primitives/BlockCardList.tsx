import * as React from "react";
import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";
import {
  type CarouselApi,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/shared/ui/carousel";

import "./blockPresentation.css";
import type { BlockCardListMode, BlockCardListNode } from "./types";

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
  presentation,
  renderItem,
}: {
  className?: string;
  items: readonly unknown[];
  mode?: BlockCardListMode;
  presentation?: BlockCardListNode["presentation"];
  renderItem: (item: unknown, index: number) => ReactNode;
}) {
  const entries = keyedItems(items);
  const [api, setApi] = React.useState<CarouselApi>();
  const [current, setCurrent] = React.useState(0);
  React.useEffect(() => {
    if (!api) return;
    const update = () => setCurrent(api.selectedScrollSnap());
    update();
    api.on("select", update);
    api.on("reInit", update);
    return () => {
      api.off("select", update);
      api.off("reInit", update);
    };
  }, [api]);

  if (items.length === 0)
    return (
      <p
        className={cn(
          "rounded-xl border border-dashed border-border/60 px-5 py-8 text-center text-sm text-muted-foreground",
          className,
        )}
        data-block-primitive="card-list"
      >
        Nothing to show yet.
      </p>
    );

  if (mode === "carousel")
    return (
      <div
        className={cn("block-native-collection", className)}
        data-block-primitive="card-list"
      >
        <Carousel
          aria-label="Block card collection"
          opts={{ align: "start", loop: false }}
          setApi={setApi}
        >
          <CarouselContent>
            {entries.map((entry) => (
              <CarouselItem
                className="min-w-0 @2xl/block-collection:basis-1/2"
                key={entry.key}
              >
                {renderItem(entry.item, entry.index)}
              </CarouselItem>
            ))}
          </CarouselContent>
          {items.length > 1 ? (
            <div className="mt-4 flex items-center justify-between gap-3">
              <span
                className="text-sm text-muted-foreground"
                aria-live="polite"
              >
                {current + 1} of {items.length}
              </span>
              <div className="flex gap-2">
                <CarouselPrevious className="static translate-y-0" />
                <CarouselNext className="static translate-y-0" />
              </div>
            </div>
          ) : null}
        </Carousel>
      </div>
    );

  const List = presentation === "numbered" ? "ol" : "ul";
  return (
    <div
      className={cn("block-native-collection", className)}
      data-block-primitive="card-list"
    >
      <List
        className={cn(
          "block-native-card-items",
          mode === "grid"
            ? "grid grid-cols-1 gap-4 @2xl/block-collection:grid-cols-2"
            : "flex flex-col gap-4",
        )}
        data-presentation={presentation}
        data-mode={mode}
      >
        {entries.map((entry) => (
          <li key={entry.key}>{renderItem(entry.item, entry.index)}</li>
        ))}
      </List>
    </div>
  );
}
