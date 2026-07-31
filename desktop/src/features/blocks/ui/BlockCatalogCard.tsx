import { Blocks, MessageCircle, ShieldCheck } from "lucide-react";

import type {
  BlockNode,
  BlockQuestionOption,
  BlockTrust,
} from "@/features/blocks/contracts";
import {
  type BlockCatalogItem,
  parseBlockWorkshopDestination,
} from "@/features/blocks/blockCatalog";
import { resolveQuestionOptions } from "@/features/blocks/questionOptions";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";

import { BlockPrimitive } from "./primitives";
import { resolveBlockTemplate, type BlockPrimitiveNode } from "./primitives";

function originLabel(origin: BlockCatalogItem["origin"]) {
  if (origin === "workspace-custom") return "Workspace";
  return origin === "core" ? "Native" : "Installed";
}

function trustLabel(trust: BlockTrust) {
  if (trust === "workspace-custom") return "Workspace trusted";
  if (trust === "installed") return "Trusted publisher";
  if (trust === "core") return "AI Native Office";
  return "Untrusted";
}

function formattedLastUsed(lastUsedAt: number | null) {
  if (lastUsedAt === null) return null;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(new Date(lastUsedAt * 1_000));
}

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

function MetadataItem({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <dt className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 text-sm text-foreground">{children}</dd>
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
  const actionLabels = manifest.actions.map((action) => action.label);
  const permissionLabels = item.permissions.map(
    (permission) => permission.capability,
  );
  const primitiveCompatibility = Object.entries(manifest.primitive_versions)
    .map(([handle, version]) => `${handle} v${version}`)
    .join(", ");
  const lastUsed = formattedLastUsed(item.recentUsage.lastUsedAt);
  const recentUsageLabel =
    item.recentUsage.count === null
      ? "Usage unavailable"
      : item.recentUsage.complete
        ? item.recentUsage.count === 0
          ? "Not used in 30 days"
          : `${item.recentUsage.count} in 30 days${lastUsed ? ` · ${lastUsed}` : ""}`
        : item.recentUsage.count === 0
          ? "No uses in recent sample"
          : `At least ${item.recentUsage.count} in recent sample${lastUsed ? ` · ${lastUsed}` : ""}`;
  const hasWorkshop = parseBlockWorkshopDestination(item.workshop) !== null;

  return (
    <article
      className="overflow-hidden rounded-2xl border border-border/65 bg-card/70 shadow-sm"
      data-block-catalog-handle={item.handle}
      data-testid={`block-catalog-card-${item.handle}`}
    >
      <div className="flex flex-col gap-4 border-b border-border/50 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-2xs font-medium text-muted-foreground">
              {originLabel(item.origin)}
            </span>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-2xs font-medium",
                trust === "untrusted"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
              )}
            >
              {trustLabel(trust)}
            </span>
            <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-2xs font-medium capitalize text-muted-foreground">
              {item.status}
            </span>
          </div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            {item.name}
          </h2>
          <p className="mt-0.5 font-mono text-xs text-primary">
            @{item.handle}
          </p>
          <p className="mt-2 max-w-2xl text-sm leading-5 text-muted-foreground">
            {item.summary}
          </p>
        </div>
        <Button
          className="shrink-0"
          data-testid={`open-block-workshop-${item.handle}`}
          onClick={() => onSelect(item)}
          size="sm"
          type="button"
          variant="outline"
        >
          <MessageCircle />
          {hasWorkshop ? "Open workshop" : "Work in chat"}
        </Button>
      </div>

      <div className="grid min-w-0 gap-0 lg:grid-cols-[minmax(0,1.45fr)_minmax(17rem,0.55fr)]">
        <div className="min-w-0 border-b border-border/50 bg-muted/10 p-4 lg:border-b-0 lg:border-r">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Blocks className="size-3.5" />
            Preview
          </div>
          <figure className="relative max-h-80 min-h-28 overflow-hidden rounded-xl border border-border/55 bg-background/65 p-4">
            <figcaption className="sr-only">
              {item.name} read-only preview
            </figcaption>
            <ReadonlyBlockPreview data={item.preview} node={manifest.tree} />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background/85 to-transparent"
            />
          </figure>
        </div>

        <dl className="grid content-start grid-cols-2 gap-x-4 gap-y-4 p-4">
          <MetadataItem label="Active version">
            v{manifest.version}
          </MetadataItem>
          <MetadataItem label="Recent use">{recentUsageLabel}</MetadataItem>
          <MetadataItem className="col-span-2" label="Publisher">
            <span
              className="inline-flex max-w-full items-center gap-1.5 font-mono text-xs"
              title={item.publisherPubkey}
            >
              <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" />
              {truncatePubkey(item.publisherPubkey)}
            </span>
          </MetadataItem>
          <MetadataItem className="col-span-2" label="Permissions">
            {permissionLabels.length > 0
              ? permissionLabels.join(", ")
              : "No special permissions"}
          </MetadataItem>
          <MetadataItem className="col-span-2" label="Compatible clients">
            {manifest.supported_clients.join(", ") || "Not declared"}
          </MetadataItem>
          <MetadataItem className="col-span-2" label="Primitive contract">
            {primitiveCompatibility || "No native primitives"}
          </MetadataItem>
          <MetadataItem className="col-span-2" label="Supported actions">
            {actionLabels.length > 0 ? actionLabels.join(", ") : "Display only"}
          </MetadataItem>
        </dl>
      </div>
    </article>
  );
}
