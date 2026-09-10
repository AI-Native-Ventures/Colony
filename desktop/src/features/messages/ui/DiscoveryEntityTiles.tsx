import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  DISCOVERY_ASSETS,
  resolveDiscoveryAsset,
} from "@/features/discovery/assets";
import type {
  ResolvedDiscoveryEntity,
  ResolvedDiscoveryLead,
  ResolvedDiscoveryLeadStatus,
  ResolvedDiscoveryTaxonomy,
} from "@/features/discovery/data/DiscoveryDataSource";
import { parseDiscoveryEntityTags } from "@/features/messages/lib/discoveryEntityTags";
import { discoveryTileLayout } from "@/features/messages/lib/discoveryTileLayout";
import { useResolvedDiscoveryEntities } from "@/features/messages/lib/useResolvedDiscoveryEntities";
import { cn } from "@/shared/lib/cn";

/**
 * The Discovery entities a message points at, rendered as live tiles.
 *
 * The message carries only `kind` and `id`; everything shown here is read
 * back from the relay at render time and permission-checked there, so a tile
 * always shows the entity's current name and status, and shows nothing at all
 * for a record this reader may not see. That is the whole reason these are
 * tiles rather than a Block snapshot: a Block freezes its content at post
 * time, which is right for an email and wrong for a lead that moves through a
 * funnel.
 */

const TILE_SURFACE =
  "rounded-[0.875rem] border border-border/70 bg-card text-left transition-colors hover:border-primary/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

/** Deterministic letter-avatar colours; no external logo service is called. */
const AVATAR_COLORS = [
  "#1f7ae0",
  "#e0561f",
  "#1fa37a",
  "#7a4fd6",
  "#c2410c",
  "#0f766e",
  "#b91c5c",
  "#4d7c0f",
] as const;

const STATUS_WORDS: Record<ResolvedDiscoveryLeadStatus, string> = {
  candidate: "candidate",
  accepted: "accepted",
  qualified: "qualified",
  dormant: "dormant",
  disqualified: "disqualified",
  client_active: "converted",
};

const RUN_STATE_WORDS: Record<string, string> = {
  queued: "queued",
  running: "running",
  succeeded: "complete",
  cancelled: "cancelled",
  failed: "failed",
};

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function avatarColor(name: string): string {
  return AVATAR_COLORS[hashText(name) % AVATAR_COLORS.length] as string;
}

function avatarLetter(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

function leadCountLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "lead" : "leads"}`;
}

function ratingLabel(lead: ResolvedDiscoveryLead): string | null {
  if (typeof lead.rating_hundredths !== "number") return null;
  const rating = (lead.rating_hundredths / 100).toFixed(1);
  return typeof lead.reviews_count === "number"
    ? `${rating} (${lead.reviews_count.toLocaleString("en-US")})`
    : rating;
}

function leadMetaLine(lead: ResolvedDiscoveryLead): string | null {
  const parts = [lead.city ?? null, ratingLabel(lead)].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

function taxonomyImageSrc(taxonomy: ResolvedDiscoveryTaxonomy): string {
  const verticalKey = taxonomy.vertical_id
    ? `vertical.${taxonomy.vertical_id}`
    : null;
  if (verticalKey && verticalKey in DISCOVERY_ASSETS) {
    return resolveDiscoveryAsset(verticalKey);
  }
  return resolveDiscoveryAsset(`industry.${taxonomy.industry_id}`);
}

/**
 * The small lowercase state pill, matching the Block status pill approved in
 * PR #682: small radius, muted ground, primary tint when the state is a live
 * one rather than a resting one.
 */
function StatePill({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "primary" | "destructive";
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md px-2 py-1 text-2xs font-medium lowercase",
        tone === "primary" && "bg-primary/10 text-primary",
        tone === "destructive" && "bg-destructive/10 text-destructive",
        tone === "muted" && "bg-muted/50 text-muted-foreground",
      )}
      data-testid="discovery-tile-pill"
    >
      {children}
    </span>
  );
}

function statusTone(
  status: ResolvedDiscoveryLeadStatus,
): "muted" | "primary" | "destructive" {
  if (status === "qualified" || status === "client_active") return "primary";
  if (status === "disqualified") return "destructive";
  return "muted";
}

function TaxonomyTile({
  kind,
  onOpen,
  taxonomy,
  wide,
}: {
  kind: "industry" | "vertical";
  onOpen: () => void;
  taxonomy: ResolvedDiscoveryTaxonomy;
  wide: boolean;
}) {
  const label =
    kind === "vertical"
      ? (taxonomy.vertical_label ?? taxonomy.industry_label)
      : taxonomy.industry_label;
  return (
    <button
      className={cn(
        TILE_SURFACE,
        "group grid overflow-hidden",
        wide ? "col-span-full grid-cols-[10.5rem_1fr]" : "grid-cols-1",
      )}
      data-testid={`discovery-tile-${kind}`}
      onClick={onOpen}
      type="button"
    >
      <div className="relative min-h-[6.75rem] overflow-hidden bg-gradient-to-br from-primary/15 to-background">
        <img
          alt=""
          aria-hidden="true"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          src={taxonomyImageSrc(taxonomy)}
        />
        <span className="absolute right-2 top-2 rounded-full bg-primary px-2 py-1 text-3xs font-semibold uppercase tracking-[0.14em] text-primary-foreground">
          {kind === "vertical" ? "Vertical" : "Industry"}
        </span>
      </div>
      <div className="min-w-0 px-4 py-3.5">
        <div className="truncate text-sm font-semibold text-foreground">
          {label}
        </div>
        <div className="mt-1 flex items-center justify-between gap-3 font-mono text-2xs uppercase text-muted-foreground">
          <span className="truncate">{taxonomy.industry_label}</span>
          {taxonomy.lead_count > 0 ? (
            <span className="shrink-0 text-foreground/70">
              {leadCountLabel(taxonomy.lead_count)}
            </span>
          ) : null}
        </div>
        {taxonomy.description ? (
          <p className="mt-2 truncate text-sm text-muted-foreground">
            {taxonomy.description}
          </p>
        ) : null}
      </div>
    </button>
  );
}

function LeadTile({
  lead,
  onOpen,
  wide,
}: {
  lead: ResolvedDiscoveryLead;
  onOpen: () => void;
  wide: boolean;
}) {
  return (
    <button
      className={cn(
        TILE_SURFACE,
        "flex min-w-0 items-center gap-3 p-3",
        wide && "col-span-full",
      )}
      data-testid="discovery-tile-lead"
      onClick={onOpen}
      type="button"
    >
      <span
        aria-hidden="true"
        className="grid h-10 w-10 shrink-0 place-items-center rounded-[0.625rem] text-sm font-bold text-white"
        style={{ backgroundColor: avatarColor(lead.name) }}
      >
        {avatarLetter(lead.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">
          {lead.name}
        </span>
        {leadMetaLine(lead) ? (
          <span className="block truncate text-sm text-muted-foreground">
            {leadMetaLine(lead)}
          </span>
        ) : null}
      </span>
      <StatePill tone={statusTone(lead.status)}>
        {STATUS_WORDS[lead.status]}
      </StatePill>
    </button>
  );
}

function UnavailableTile({ wide }: { wide: boolean }) {
  return (
    <div
      className={cn(
        "rounded-[0.875rem] border border-dashed border-border/70 bg-card p-3 text-sm text-muted-foreground",
        wide && "col-span-full",
      )}
      data-testid="discovery-tile-unavailable"
    >
      This entity is not available.
    </div>
  );
}

export type DiscoveryEntityTilesProps = {
  className?: string;
  tags?: string[][];
};

export function DiscoveryEntityTiles({
  className,
  tags,
}: DiscoveryEntityTilesProps) {
  const { goDiscovery } = useAppNavigation();
  const refs = React.useMemo(() => parseDiscoveryEntityTags(tags), [tags]);
  const { entities } = useResolvedDiscoveryEntities(refs);
  const layout = discoveryTileLayout(entities.length);

  const openLead = React.useCallback(
    (leadId: string) => {
      void goDiscovery({ surface: "leads", leadId });
    },
    [goDiscovery],
  );
  const openCampaignLeads = React.useCallback(
    (campaignId: string | undefined) => {
      void goDiscovery({ surface: "leads", campaignId });
    },
    [goDiscovery],
  );

  if (entities.length === 0) return null;

  const visible = entities.slice(0, layout.visibleCount);
  const wide = layout.variant === "wide";
  /** The campaign every referenced lead belongs to, when they share one. */
  const overflowCampaignId = campaignIdOf(entities);

  return (
    <div
      className={cn(
        "mt-2 grid max-w-[42.5rem] gap-3",
        wide ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2",
        className,
      )}
      data-testid="discovery-entity-tiles"
    >
      {visible.map((entity) => (
        <DiscoveryEntityTile
          entity={entity}
          key={entityKey(entity)}
          onOpenCampaignLeads={openCampaignLeads}
          onOpenLead={openLead}
          wide={wide}
        />
      ))}
      {layout.hiddenCount > 0 ? (
        <button
          className="col-span-full justify-self-start rounded-md px-2 py-1 text-sm font-medium text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="discovery-tiles-show-all"
          onClick={() => openCampaignLeads(overflowCampaignId)}
          type="button"
        >
          Show all {entities.length}
        </button>
      ) : null}
    </div>
  );
}

function entityKey(entity: ResolvedDiscoveryEntity): string {
  switch (entity.resolved) {
    case "industry":
    case "vertical":
      return `${entity.resolved}:${entity.taxonomy.industry_id}/${entity.taxonomy.vertical_id ?? ""}`;
    case "campaign":
      return `campaign:${entity.campaign.campaign_id}`;
    case "campaign_leads":
      return `campaign_leads:${entity.collection.campaign_id}`;
    case "lead":
      return `lead:${entity.lead.lead_id}`;
    case "run":
      return `run:${entity.run.run_id}`;
    default:
      return `unavailable:${entity.kind}:${entity.id}`;
  }
}

/** The campaign shared by every resolved lead, when there is exactly one. */
function campaignIdOf(
  entities: readonly ResolvedDiscoveryEntity[],
): string | undefined {
  const campaigns = new Set<string>();
  for (const entity of entities) {
    if (entity.resolved === "lead") campaigns.add(entity.lead.campaign_id);
    if (entity.resolved === "campaign_leads") {
      campaigns.add(entity.collection.campaign_id);
    }
    if (entity.resolved === "campaign")
      campaigns.add(entity.campaign.campaign_id);
  }
  return campaigns.size === 1 ? [...campaigns][0] : undefined;
}

function DiscoveryEntityTile({
  entity,
  onOpenCampaignLeads,
  onOpenLead,
  wide,
}: {
  entity: ResolvedDiscoveryEntity;
  onOpenCampaignLeads: (campaignId: string | undefined) => void;
  onOpenLead: (leadId: string) => void;
  wide: boolean;
}) {
  const { goDiscovery } = useAppNavigation();
  switch (entity.resolved) {
    case "industry":
      return (
        <TaxonomyTile
          kind="industry"
          onOpen={() => {
            void goDiscovery({
              surface: "verticals",
              industryId: entity.taxonomy.industry_id,
            });
          }}
          taxonomy={entity.taxonomy}
          wide={wide}
        />
      );
    case "vertical":
      return (
        <TaxonomyTile
          kind="vertical"
          onOpen={() => {
            void goDiscovery({
              surface: "campaigns",
              industryId: entity.taxonomy.industry_id,
              verticalId: entity.taxonomy.vertical_id ?? undefined,
            });
          }}
          taxonomy={entity.taxonomy}
          wide={wide}
        />
      );
    case "campaign":
      return (
        <button
          className={cn(
            TILE_SURFACE,
            "flex min-w-0 flex-col gap-1 p-3.5",
            wide && "col-span-full",
          )}
          data-testid="discovery-tile-campaign"
          onClick={() => {
            void goDiscovery({
              surface: "campaign",
              campaignId: entity.campaign.campaign_id,
            });
          }}
          type="button"
        >
          <span className="truncate text-sm font-semibold text-foreground">
            {entity.campaign.name}
          </span>
          <span className="flex items-center justify-between gap-3 font-mono text-2xs uppercase text-muted-foreground">
            <span className="truncate">
              {entity.campaign.industry_name} · {entity.campaign.vertical_name}
            </span>
            <span className="shrink-0 text-foreground/70">
              {leadCountLabel(entity.campaign.lead_count)}
            </span>
          </span>
        </button>
      );
    case "campaign_leads":
      return (
        <div
          className={cn(
            "col-span-full rounded-[0.875rem] border border-border/70 bg-card p-3.5",
          )}
          data-testid="discovery-tile-campaign-leads"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-foreground">
              {leadCountLabel(entity.collection.total)}
            </span>
            {entity.collection.total > entity.collection.leads.length ? (
              <button
                className="rounded-md px-2 py-1 text-sm font-medium text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="discovery-tile-collection-show-all"
                onClick={() =>
                  onOpenCampaignLeads(entity.collection.campaign_id)
                }
                type="button"
              >
                Show all {entity.collection.total}
              </button>
            ) : null}
          </div>
          <div className="mt-2 grid gap-2">
            {entity.collection.leads.slice(0, 4).map((lead) => (
              <LeadTile
                key={lead.lead_id}
                lead={lead}
                onOpen={() => onOpenLead(lead.lead_id)}
                wide={false}
              />
            ))}
          </div>
        </div>
      );
    case "lead":
      return (
        <LeadTile
          lead={entity.lead}
          onOpen={() => onOpenLead(entity.lead.lead_id)}
          wide={wide}
        />
      );
    case "run": {
      const percent =
        entity.run.total_steps > 0
          ? Math.round(
              (entity.run.completed_steps / entity.run.total_steps) * 100,
            )
          : 0;
      return (
        <button
          className={cn(
            TILE_SURFACE,
            "flex min-w-0 flex-col gap-2 p-3.5",
            wide && "col-span-full",
          )}
          data-testid="discovery-tile-run"
          onClick={() => {
            void goDiscovery({
              surface: "campaign",
              campaignId: entity.run.campaign_id,
            });
          }}
          type="button"
        >
          <span className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-foreground">Run</span>
            <StatePill
              tone={entity.run.state === "failed" ? "destructive" : "primary"}
            >
              {RUN_STATE_WORDS[entity.run.state] ?? entity.run.state}
            </StatePill>
          </span>
          <span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary"
              style={{ width: `${percent}%` }}
            />
          </span>
          <span className="font-mono text-2xs uppercase text-muted-foreground">
            {entity.run.completed_steps} of {entity.run.total_steps}
          </span>
        </button>
      );
    }
    default:
      return <UnavailableTile wide={wide} />;
  }
}
