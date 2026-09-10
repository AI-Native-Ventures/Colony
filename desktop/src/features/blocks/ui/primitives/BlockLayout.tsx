import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";

import "./blockPresentation.css";
import { resolveLayout } from "./resolvers";
import type { BlockLayoutNode } from "./types";

const GAP_CLASSES = {
  small: "gap-3",
  medium: "gap-5",
  large: "gap-7",
} as const;
const GRID_CLASSES = {
  1: "grid-cols-1",
  2: "grid-cols-1 @sm/block-layout:grid-cols-2",
  3: "grid-cols-1 @sm/block-layout:grid-cols-2 @2xl/block-layout:grid-cols-3",
  4: "grid-cols-1 @sm/block-layout:grid-cols-2 @4xl/block-layout:grid-cols-4",
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
      className={cn("block-native-layout", className)}
      data-block-primitive={node.type}
    >
      <div
        data-layout-children
        className={cn(
          layout.kind === "stack" ? "flex flex-col" : "grid",
          GAP_CLASSES[layout.gap],
          layout.kind === "grid" &&
            GRID_CLASSES[layout.columns as keyof typeof GRID_CLASSES],
        )}
      >
        {children}
      </div>
    </div>
  );
}
