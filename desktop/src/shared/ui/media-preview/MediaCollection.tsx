import * as React from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import type { VideoReviewContext } from "../VideoPlayer";
import { ImagePreview } from "./ImagePreview";
import {
  MediaCollectionViewer,
  type MediaCollectionViewState,
} from "./MediaCollectionViewer";
import {
  keyMediaCollection,
  mediaCollectionLabel,
  mediaCollectionType,
  type MediaCollectionEntry,
} from "./mediaCollectionModel";

/** An ordered, named collection with a single active heavyweight preview. */
export function MediaCollection({
  entries,
  title,
  className,
  reviewContext,
}: {
  entries: readonly MediaCollectionEntry[];
  title?: string;
  className?: string;
  reviewContext?: VideoReviewContext;
}) {
  const id = React.useId();
  const keyed = keyMediaCollection(entries);
  const [selected, setSelected] = React.useState<string>();
  const states = React.useRef(new Map<string, MediaCollectionViewState>());
  const active =
    keyed.find((entry) => entry.key === selected && entry.item) ??
    keyed.find((entry) => entry.item);
  const keys = keyed.map((entry) => entry.key);
  React.useEffect(() => {
    for (const key of states.current.keys()) {
      if (!keys.includes(key)) states.current.delete(key);
    }
  }, [keys]);
  if (!keyed.length) return null;
  const images = keyed.flatMap((entry) =>
    entry.item?.kind === "image"
      ? [
          {
            ...entry.item,
            alt: entry.item.alt ?? mediaCollectionLabel(entry.item),
          },
        ]
      : [],
  );
  if (images.length === keyed.length)
    return <ImagePreview items={images} title={title} className={className} />;
  let state: MediaCollectionViewState | undefined;
  if (active) {
    state = states.current.get(active.key) ?? {};
    states.current.set(active.key, state);
  }
  const count = keyed.filter((entry) => entry.item).length;
  return (
    <section
      aria-label={title ?? "Files in this message"}
      className={cn("my-2 w-full min-w-0 space-y-3 text-foreground", className)}
      data-testid="media-collection"
    >
      {keyed.length > 1 ? (
        <>
          <div className="flex min-w-0 items-baseline justify-between gap-3">
            <h3 className="min-w-0 truncate text-sm font-semibold">
              {title ?? "Files in this message"}
            </h3>
            <span className="shrink-0 text-xs text-muted-foreground">
              {count} {count === 1 ? "file" : "files"}
            </span>
          </div>
          <fieldset
            className="max-h-72 w-full min-w-0 space-y-1 overflow-y-auto rounded-lg bg-muted/25 p-1"
            aria-label="Choose a file"
          >
            {keyed.map((entry, index) =>
              entry.item ? (
                <button
                  key={entry.key}
                  type="button"
                  aria-pressed={entry.key === active?.key}
                  aria-controls={`${id}-preview`}
                  aria-label={`View file ${index + 1}: ${mediaCollectionLabel(entry.item)}`}
                  onClick={() => setSelected(entry.key)}
                  className={cn(
                    "flex min-h-12 w-full min-w-0 items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    entry.key === active?.key
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground",
                  )}
                >
                  {entry.item.poster || entry.item.thumbnailSrc ? (
                    <img
                      src={entry.item.poster ?? entry.item.thumbnailSrc}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-9 w-12 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <span className="flex h-9 w-12 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold tracking-wide">
                      {mediaCollectionType(entry.item)}
                    </span>
                  )}
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={mediaCollectionLabel(entry.item)}
                  >
                    {mediaCollectionLabel(entry.item)}
                  </span>
                  <span className="shrink-0 text-xs">
                    {entry.key === active?.key ? "Viewing" : "View →"}
                  </span>
                </button>
              ) : (
                <Unavailable
                  key={entry.key}
                  reason={entry.reason}
                  position={index + 1}
                />
              ),
            )}
          </fieldset>
        </>
      ) : null}
      {active?.item && state ? (
        <section
          id={`${id}-preview`}
          aria-label={`Preview: ${mediaCollectionLabel(active.item)}`}
          className="min-w-0"
        >
          <MediaCollectionViewer
            key={active.key}
            item={active.item}
            state={state}
            reviewKey={`media-collection:${id}:${active.key}`}
            reviewContext={reviewContext}
          />
        </section>
      ) : keyed.length === 1 ? (
        <Unavailable reason={keyed[0].reason ?? "Media unavailable."} />
      ) : null}
    </section>
  );
}

function Unavailable({
  reason,
  position,
}: {
  reason: string;
  position?: number;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-lg bg-muted/30 px-3 py-3 text-sm text-muted-foreground"
      role="status"
    >
      <ImageOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        {position ? `Item ${position}: ` : ""}
        {reason}
      </span>
    </div>
  );
}
