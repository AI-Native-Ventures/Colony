import { cn } from "@/shared/lib/cn";

import "./blockPresentation.css";
import { resolveBlockTemplate, resolveDetails } from "./resolvers";
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
  const items = resolveDetails(node, data, rootData).filter((item) =>
    item.value.trim(),
  );
  if (items.length === 0) return null;
  const occurrences = new Map<string, number>();
  const entries = items.map((item) => {
    const identity = `${item.label}:${item.value}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { ...item, key: `${identity}:${occurrence}` };
  });
  const content = (
    <dl className="block-native-details min-w-0 text-sm leading-relaxed">
      {entries.map((item) => (
        <div className="block-native-details-row" key={item.key}>
          <dt className="block-native-copy min-w-0 text-muted-foreground">
            {item.label}
          </dt>
          <dd className="block-native-copy min-w-0 text-foreground">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
  return node.presentation === "disclosure" ? (
    <details
      className={cn("block-native-disclosure", className)}
      data-block-primitive="details"
    >
      <summary className="rounded-sm text-sm font-medium text-muted-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
        {resolveBlockTemplate(node.summary, data, rootData) ||
          "Reference details"}
      </summary>
      {content}
    </details>
  ) : (
    <div className={className} data-block-primitive="details">
      {content}
    </div>
  );
}
