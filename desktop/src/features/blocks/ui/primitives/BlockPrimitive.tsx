import type { ReactNode } from "react";

import { BlockActions } from "./BlockActions";
import { BlockCard } from "./BlockCard";
import { BlockCardList } from "./BlockCardList";
import { BlockChart } from "./BlockChart";
import { BlockDetails } from "./BlockDetails";
import { BlockLayout } from "./BlockLayout";
import { BlockMedia } from "./BlockMedia";
import { BlockMetric } from "./BlockMetric";
import { BlockQuestion } from "./BlockQuestion";
import { BlockSection } from "./BlockSection";
import { BlockStatus } from "./BlockStatus";
import { BlockTable } from "./BlockTable";
import { resolveCardListItems } from "./resolvers";
import type { BlockPrimitiveNode, BlockPrimitiveRenderContext } from "./types";

const SUPPORTED_TYPES = new Set([
  "stack",
  "grid",
  "section",
  "metric",
  "details",
  "status",
  "actions",
  "table",
  "card",
  "card-list",
  "chart",
  "media",
  "question",
]);

export function supportsBlockPrimitiveType(
  value: unknown,
): value is BlockPrimitiveNode["type"] {
  return typeof value === "string" && SUPPORTED_TYPES.has(value);
}

export function BlockPrimitive({
  context,
  node,
}: {
  context: BlockPrimitiveRenderContext;
  node: BlockPrimitiveNode;
}): ReactNode {
  const rootData = context.rootData ?? context.data;
  const renderChild =
    context.renderChild ??
    ((child: BlockPrimitiveNode, key: string, childData: unknown) => (
      <BlockPrimitive
        context={{ ...context, data: childData, rootData }}
        key={key}
        node={child}
      />
    ));

  switch (node.type) {
    case "stack":
    case "grid":
      return (
        <BlockLayout node={node}>
          {node.children.map((child, index) =>
            renderChild(child, `${node.type}-${index}`, context.data),
          )}
        </BlockLayout>
      );
    case "section":
      return (
        <BlockSection data={context.data} node={node} rootData={rootData} />
      );
    case "metric":
      return (
        <BlockMetric data={context.data} node={node} rootData={rootData} />
      );
    case "details":
      return (
        <BlockDetails data={context.data} node={node} rootData={rootData} />
      );
    case "status":
      return (
        <BlockStatus
          attentionResolution={context.attentionResolution}
          data={context.data}
          node={node}
          rootData={rootData}
        />
      );
    case "actions":
      if (context.attentionResolution) return null;
      return (
        <BlockActions environment={context.actionEnvironment} node={node} />
      );
    case "table":
      return <BlockTable data={context.data} node={node} />;
    case "card":
      return (
        <BlockCard data={context.data} node={node} rootData={rootData}>
          {node.children?.map((child, index) =>
            renderChild(child, `card-${index}`, context.data),
          )}
        </BlockCard>
      );
    case "card-list": {
      const items = resolveCardListItems(context.data, node.items_path);
      return (
        <BlockCardList
          items={items}
          mode={node.mode}
          renderItem={(item, index) =>
            renderChild(node.card, `card-list-${index}`, item)
          }
        />
      );
    }
    case "chart":
      return <BlockChart data={context.data} node={node} />;
    case "media":
      return (
        <BlockMedia
          data={context.data}
          items={context.mediaItems}
          node={node}
          rootData={rootData}
        />
      );
    case "question":
      return (
        <BlockQuestion
          data={rootData}
          environment={context.actionEnvironment}
          node={node}
        />
      );
  }
}
