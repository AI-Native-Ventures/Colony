import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";

import { resolveLayout } from "./resolvers";
import type { BlockLayoutNode } from "./types";

const GAP_CLASSES = {
  small: "gap-2",
  medium: "gap-3",
  large: "gap-5",
} as const;

const GRID_CLASSES = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
} as const;

export function BlockLayout({
  children,
  className,
  node,
}: {
  children: ReactNode;
  className?: string;
  node: BlockLayoutNode;
}) {
  const layout = resolveLayout(node);
  return (
    <div
      className={cn(
        layout.kind === "stack" ? "flex flex-col" : "grid",
        GAP_CLASSES[layout.gap],
        layout.kind === "grid" &&
          GRID_CLASSES[layout.columns as keyof typeof GRID_CLASSES],
        className,
      )}
      data-block-primitive={node.type}
    >
      {children}
    </div>
  );
}
