import { cn } from "@/shared/lib/cn";

import { resolveSection } from "./resolvers";
import type { BlockSectionNode } from "./types";

export function BlockSection({
  className,
  data,
  headingLevel = 3,
  node,
  rootData,
}: {
  className?: string;
  data: unknown;
  headingLevel?: 2 | 3 | 4;
  node: BlockSectionNode;
  rootData?: unknown;
}) {
  const resolved = resolveSection(node, data, rootData);
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  if (!resolved.title && !resolved.text) return null;

  return (
    <section
      className={cn("min-w-0 space-y-1.5", className)}
      data-block-primitive="section"
    >
      {resolved.title ? (
        <Heading className="text-sm font-semibold leading-5 text-foreground">
          {resolved.title}
        </Heading>
      ) : null}
      {resolved.text ? (
        <p className="whitespace-pre-wrap text-sm leading-5 text-muted-foreground">
          {resolved.text}
        </p>
      ) : null}
    </section>
  );
}
