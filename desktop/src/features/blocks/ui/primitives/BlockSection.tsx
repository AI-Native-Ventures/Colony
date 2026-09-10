import { cn } from "@/shared/lib/cn";

import "./blockPresentation.css";
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
  if (
    (!resolved.title.trim() && !resolved.text.trim()) ||
    (node.omit_empty_text && !resolved.text.trim())
  )
    return null;
  return (
    <section
      className={cn("block-native-section min-w-0 space-y-2", className)}
      data-block-primitive="section"
      data-presentation={node.presentation ?? "body"}
    >
      {resolved.title ? (
        <Heading
          className={cn(
            "block-native-copy font-semibold leading-snug text-foreground",
            node.presentation === "lead"
              ? "text-2xl tracking-tight"
              : "text-base",
          )}
        >
          {resolved.title}
        </Heading>
      ) : null}
      {resolved.text ? (
        <p className="block-native-copy text-sm leading-relaxed text-muted-foreground">
          {resolved.text}
        </p>
      ) : null}
    </section>
  );
}
