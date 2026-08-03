import * as React from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { GripVertical, Loader2 } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Switch } from "@/shared/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import {
  getDiscoveryCredentialStatus,
  type DiscoveryCredentialProvider,
  type DiscoveryCredentialStatus,
} from "@/shared/api/discoveryCredentials";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type { DiscoveryEntitlement } from "../entitlement";
import {
  canReorderSources,
  DISCOVERY_SOURCES,
  DISCOVERY_SOURCE_LABELS,
  DISCOVERY_SOURCE_PROVIDERS,
  isLiveDiscoverySource,
  moveSource,
  resolveSourceConfig,
  toggleSource,
  type CampaignSourceConfig,
  type DiscoveryMode,
  type DiscoverySource,
} from "../sourceConfig";
import type { CampaignDetail } from "../types";
import { EntitlementLock } from "./EntitlementLock";

export type SourceConfigEditorProps = {
  campaign: Pick<CampaignDetail, "id" | "sourceConfig">;
  dataSource: DiscoveryDataSource;
  entitlement: DiscoveryEntitlement | null;
  onUpdated?: (campaign: CampaignDetail) => void;
};

type SourceRowProps = {
  source: DiscoverySource;
  enabled: boolean;
  locked: boolean;
  disabled: boolean;
  entitlement: DiscoveryEntitlement | null;
  onToggle: () => void;
  hint?: string;
};

function SourceRowContents({
  source,
  enabled,
  entitlement,
  locked,
  disabled,
  onToggle,
  hint,
  dragHandle,
}: SourceRowProps & { dragHandle: React.ReactNode }) {
  return (
    <>
      {dragHandle ?? <span aria-hidden="true" className="w-6" />}
      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
        {DISCOVERY_SOURCE_LABELS[source]}
      </span>
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
      <Switch
        aria-label={`${enabled ? "Disable" : "Enable"} ${DISCOVERY_SOURCE_LABELS[source]}`}
        checked={enabled}
        disabled={disabled}
        onCheckedChange={onToggle}
      />
      {locked && entitlement?.experience !== "live" ? (
        <EntitlementLock
          actionLabel="Unlock source"
          entitlement={entitlement}
          onRetry={() => window.location.reload()}
          onRun={() => undefined}
        />
      ) : null}
    </>
  );
}

function SortableSourceRow({
  canDrag,
  ...props
}: SourceRowProps & { canDrag: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ disabled: !canDrag, id: props.source });
  const style = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
  };

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/60 p-3"
      data-enabled={props.enabled}
      data-source={props.source}
      ref={setNodeRef}
      style={style}
    >
      <SourceRowContents
        {...props}
        dragHandle={
          canDrag ? (
            <button
              aria-label={`Reorder ${DISCOVERY_SOURCE_LABELS[props.source]}`}
              className="touch-none rounded-md p-1 text-muted-foreground hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
              {...attributes}
              {...listeners}
            >
              <GripVertical aria-hidden="true" className="h-4 w-4" />
            </button>
          ) : null
        }
      />
    </div>
  );
}

function StaticSourceRow(props: SourceRowProps) {
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/60 p-3"
      data-enabled={props.enabled}
      data-source={props.source}
    >
      <SourceRowContents {...props} dragHandle={null} />
    </div>
  );
}

function sourceRows(config: CampaignSourceConfig) {
  const enabled = [...config.order];
  const disabled = DISCOVERY_SOURCES.map(({ key }) => key).filter(
    (source) => !enabled.includes(source),
  );
  return { enabled, disabled };
}

export function SourceConfigEditor({
  campaign,
  dataSource,
  entitlement,
  onUpdated,
}: SourceConfigEditorProps) {
  const [config, setConfig] = React.useState<CampaignSourceConfig>(() =>
    resolveSourceConfig(campaign.sourceConfig),
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [credentialStatuses, setCredentialStatuses] = React.useState<
    Partial<Record<DiscoveryCredentialProvider, DiscoveryCredentialStatus>>
  >({});
  const live = entitlement?.experience === "live";
  const campaignId = campaign.id;
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  React.useEffect(() => {
    if (!campaignId) return;
    setConfig(resolveSourceConfig(campaign.sourceConfig));
    setError(null);
  }, [campaign.sourceConfig, campaignId]);

  React.useEffect(() => {
    if (!live) return;
    let cancelled = false;
    void Promise.all(
      Object.values(DISCOVERY_SOURCE_PROVIDERS).map(async (provider) => {
        try {
          return [
            provider,
            await getDiscoveryCredentialStatus(provider),
          ] as const;
        } catch {
          return [provider, "unavailable"] as const;
        }
      }),
    ).then((statuses) => {
      if (!cancelled) setCredentialStatuses(Object.fromEntries(statuses));
    });
    return () => {
      cancelled = true;
    };
  }, [live]);

  const persist = React.useCallback(
    async (next: CampaignSourceConfig) => {
      const previous = config;
      setConfig(next);
      setSaving(true);
      setError(null);
      try {
        const updated = await dataSource.updateSourceConfig(campaign.id, next);
        setConfig(updated.sourceConfig);
        onUpdated?.(updated);
      } catch (cause: unknown) {
        setConfig(previous);
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not save source configuration",
        );
      } finally {
        setSaving(false);
      }
    },
    [campaign.id, config, dataSource, onUpdated],
  );

  const handleToggle = (source: DiscoverySource) => {
    const next = toggleSource(config, source);
    if (next.order.join("|") !== config.order.join("|")) void persist(next);
  };

  const handleModeChange = (mode: string) => {
    if (mode !== "waterfall" && mode !== "concurrent") return;
    const nextMode = mode as DiscoveryMode;
    if (nextMode !== config.mode) void persist({ ...config, mode: nextMode });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || !canReorderSources(config)) return;
    const next = moveSource(
      config,
      active.id as DiscoverySource,
      over.id as DiscoverySource,
    );
    if (next.order.join("|") !== config.order.join("|")) void persist(next);
  };

  const reorderable = canReorderSources(config);
  const { enabled: enabledRows, disabled: disabledRows } = sourceRows(config);
  const isLocked = (source: DiscoverySource) => {
    if (!live) {
      return (
        source === "linkedin_company_search" &&
        entitlement?.state !== "entitled"
      );
    }
    return (
      !isLiveDiscoverySource(source) ||
      credentialStatuses[DISCOVERY_SOURCE_PROVIDERS[source]] !== "configured"
    );
  };
  const sourceHint = (source: DiscoverySource) => {
    if (!live) return undefined;
    if (!isLiveDiscoverySource(source)) return "Not available yet";
    const status = credentialStatuses[DISCOVERY_SOURCE_PROVIDERS[source]];
    if (status === "configured") return "Connected";
    if (status === "unavailable") return "Secure storage unavailable";
    return "Connect in Settings";
  };
  const rowProps = (
    source: DiscoverySource,
    enabled: boolean,
  ): SourceRowProps => {
    // Missing credentials must prevent enabling a paid source, but must never
    // trap an already-enabled source in the campaign configuration.
    const locked = live && enabled ? false : isLocked(source);
    return {
      enabled,
      entitlement,
      hint: sourceHint(source),
      locked,
      disabled: locked || saving,
      onToggle: () => handleToggle(source),
      source,
    };
  };

  return (
    <Card className="space-y-4 border-border/60 bg-card/80 p-4 shadow-none">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">
            Discovery sources
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {live
              ? "Choose connected sources. Provider usage is billed directly to your own accounts."
              : "Choose where discovery searches. The enabled sources run first."}
          </p>
        </div>
        {saving ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            Saving
          </span>
        ) : null}
      </div>

      <Tabs onValueChange={handleModeChange} value={config.mode}>
        <TabsList aria-label="Discovery source execution mode">
          <TabsTrigger disabled={saving} value="waterfall">
            Waterfall
          </TabsTrigger>
          <TabsTrigger disabled={saving} value="concurrent">
            Concurrent
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <p className="text-sm text-muted-foreground">
        {config.mode === "waterfall"
          ? "Search sources one by one in the order below, stopping when the campaign target is reached."
          : "Search enabled sources at the same time for the fastest discovery run."}
      </p>

      <div className="space-y-2" data-testid="discovery-source-list">
        {config.mode === "waterfall" ? (
          <DndContext
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            sensors={sensors}
          >
            <SortableContext
              items={enabledRows}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {enabledRows.map((source) => (
                  <SortableSourceRow
                    {...rowProps(source, true)}
                    canDrag={reorderable && !isLocked(source) && !saving}
                    key={source}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <div className="space-y-2">
            {enabledRows.map((source) => (
              <StaticSourceRow {...rowProps(source, true)} key={source} />
            ))}
          </div>
        )}
        <div className="space-y-2">
          {disabledRows.map((source) => (
            <StaticSourceRow {...rowProps(source, false)} key={source} />
          ))}
        </div>
      </div>
      {config.mode === "concurrent" ? (
        <p className="text-xs text-muted-foreground">
          Ordering is disabled in concurrent mode. You can still enable or
          disable any source.
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        className="sr-only"
        onClick={() => void persist(config)}
        tabIndex={-1}
        type="button"
      >
        Save source configuration
      </Button>
    </Card>
  );
}
