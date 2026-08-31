import { ChevronRight, TriangleAlert } from "lucide-react";

import type {
  BlockNode,
  BlockQuestionOption,
} from "@/features/blocks/contracts";
import {
  type BlockCatalogItem,
  parseBlockWorkshopDestination,
} from "@/features/blocks/blockCatalog";
import { resolveQuestionOptions } from "@/features/blocks/questionOptions";
import { Button } from "@/shared/ui/button";

import { BlockPrimitive } from "./primitives";
import { resolveBlockTemplate, type BlockPrimitiveNode } from "./primitives";

function ReadonlyActionsPreview({ labels }: { labels: readonly string[] }) {
  if (labels.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-1.5"
      data-block-catalog-preview="actions"
    >
      {labels.map((label) => (
        <span
          className="rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
          key={label}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

function ReadonlyQuestionPreview({
  data,
  node,
}: {
  data: unknown;
  node: Extract<BlockNode, { type: "question" }>;
}) {
  const optionsResult = resolveQuestionOptions(node, data);
  const options: readonly BlockQuestionOption[] = optionsResult.ok
    ? optionsResult.options
    : [];
  return (
    <section
      className="space-y-2.5 rounded-lg border border-border/60 bg-background/45 p-3"
      data-block-catalog-preview="question"
    >
      <h4 className="text-sm font-medium text-foreground">
        {resolveBlockTemplate(node.prompt, data)}
      </h4>
      {options.length > 0 ? (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {options.slice(0, 4).map((option) => (
            <div
              className="rounded-md border border-border/50 bg-muted/20 px-2.5 py-2"
              key={option.id}
            >
              <p className="text-xs font-medium text-foreground">
                {option.label}
              </p>
              {option.description ? (
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  {option.description}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {node.allow_custom ? (
        <p className="text-xs text-muted-foreground">
          Custom responses are supported.
        </p>
      ) : null}
    </section>
  );
}

function ReadonlyBlockPreview({
  data,
  node,
  rootData = data,
}: {
  data: unknown;
  node: BlockNode;
  rootData?: unknown;
}) {
  if (node.type === "actions") {
    return (
      <ReadonlyActionsPreview
        labels={node.controls.map((control) => control.label)}
      />
    );
  }
  if (node.type === "question") {
    return <ReadonlyQuestionPreview data={rootData} node={node} />;
  }

  return (
    <BlockPrimitive
      context={{
        data,
        rootData,
        renderChild: (child, key, childData) => (
          <ReadonlyBlockPreview
            data={childData}
            key={key}
            node={child as BlockNode}
            rootData={rootData}
          />
        ),
      }}
      node={node as BlockPrimitiveNode}
    />
  );
}

/**
 * The shelf shows a block, not a dossier. Only the two facts that could change
 * someone's mind about opening it are surfaced: that the publisher is untrusted,
 * and any capability the block asks for. Version, usage, publisher key,
 * compatible clients and primitive contracts belong in the workshop, where a
 * person is inspecting one block rather than scanning for one.
 */
function BlockConcerns({
  permissionLabels,
  untrusted,
}: {
  permissionLabels: readonly string[];
  untrusted: boolean;
}) {
  if (!untrusted && permissionLabels.length === 0) return null;
  return (
    <div className="mt-4 space-y-1.5">
      {untrusted ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          Untrusted publisher
        </p>
      ) : null}
      {permissionLabels.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Requires {permissionLabels.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

export function BlockCatalogCard({
  item,
  onSelect,
}: {
  item: BlockCatalogItem;
  onSelect: (item: BlockCatalogItem) => void;
}) {
  const { manifest, trust } = item.manifestRecord;
  const permissionLabels = item.permissions.map(
    (permission) => permission.capability,
  );
  const hasWorkshop = parseBlockWorkshopDestination(item.workshop) !== null;

  return (
    <article
      className="grid min-w-0 gap-6 border-t border-border/50 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-center lg:gap-12"
      data-block-catalog-handle={item.handle}
      data-testid={`block-catalog-card-${item.handle}`}
    >
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          {item.name}
        </h2>
        <p className="mt-0.5 font-mono text-xs text-primary">@{item.handle}</p>
        <p className="mt-2.5 max-w-[44ch] text-sm leading-5 text-muted-foreground">
          {item.summary}
        </p>
        <Button
          className="mt-4 h-auto p-0 font-medium text-foreground"
          data-testid={`open-block-workshop-${item.handle}`}
          onClick={() => onSelect(item)}
          size="sm"
          type="button"
          variant="link"
        >
          {hasWorkshop ? "Open workshop" : "Work in chat"}
          <ChevronRight aria-hidden="true" className="size-3.5" />
        </Button>
        <BlockConcerns
          permissionLabels={permissionLabels}
          untrusted={trust === "untrusted"}
        />
      </div>

      <figure className="min-w-0">
        <figcaption className="sr-only">
          {item.name} read-only preview
        </figcaption>
        <ReadonlyBlockPreview data={item.preview} node={manifest.tree} />
      </figure>
    </article>
  );
}
