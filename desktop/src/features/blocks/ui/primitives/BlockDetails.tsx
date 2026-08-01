import { cn } from "@/shared/lib/cn";

import { resolveDetails } from "./resolvers";
import type { BlockDetailsNode } from "./types";

export function BlockDetails({
  className,
  data,
  node,
  rootData,
}: {
  className?: string;
  data: unknown;
  node: BlockDetailsNode;
  rootData?: unknown;
}) {
  const items = resolveDetails(node, data, rootData).filter(
    (item) => item.label || item.value,
  );
  if (items.length === 0) return null;

  return (
    <dl
      className={cn(
        "grid min-w-0 grid-cols-[minmax(0,0.4fr)_minmax(0,0.6fr)] gap-x-4 gap-y-2 text-sm",
        className,
      )}
      data-block-primitive="details"
    >
      {items.map((item) => (
        <div className="contents" key={`${item.label}:${item.value}`}>
          <dt className="min-w-0 text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">
            {item.value || "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}
