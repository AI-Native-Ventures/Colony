import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";

import "./blockPresentation.css";
import { resolveBlockTemplate, resolveCard } from "./resolvers";
import type { BlockCardNode } from "./types";

export function BlockCard({
  children,
  className,
  data,
  node,
  rootData,
}: {
  children?: ReactNode;
  className?: string;
  data: unknown;
  node: BlockCardNode;
  rootData?: unknown;
}) {
  const card = resolveCard(node, data, rootData);
  const eyebrow = resolveBlockTemplate(node.eyebrow, data, rootData);
  const subtitle = resolveBlockTemplate(node.subtitle, data, rootData);
  return (
    <div
      className={cn("block-native-card", className)}
      data-block-primitive="card"
      data-presentation={node.presentation ?? "surface"}
    >
      {eyebrow || card.title || subtitle || card.description ? (
        <div className="block-native-card-header">
          {eyebrow ? (
            <p className="block-native-copy text-xs font-medium tracking-wide text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          {card.title ? (
            <h3
              className={cn(
                "block-native-copy font-semibold leading-snug text-foreground",
                node.presentation === "row" || node.presentation === "rail"
                  ? "text-base"
                  : "text-xl",
              )}
            >
              {card.title}
            </h3>
          ) : null}
          {subtitle ? (
            <p className="block-native-copy text-sm text-muted-foreground">
              {subtitle}
            </p>
          ) : null}
          {card.description ? (
            <p className="block-native-copy text-sm leading-relaxed text-muted-foreground">
              {card.description}
            </p>
          ) : null}
        </div>
      ) : null}
      {children ? <div className="min-w-0 space-y-4">{children}</div> : null}
    </div>
  );
}
