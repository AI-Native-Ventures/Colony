import * as React from "react";
import { ArrowRight, RefreshCw } from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import {
  PIPELINE_COLUMN_LABELS,
  pipelineMoveTargets,
} from "../lib/pipelineTransitions";
import type { Lead, LeadFunnelStatus, PipelineColumn } from "../types";
import { PIPELINE_COLUMN_STATUSES } from "../types";

export type PipelineWorkspaceProps = {
  dataSource: DiscoveryDataSource;
  onOpenLead: (leadId: string) => void;
};

/**
 * The status funnel: one bounded, status-filtered `list_leads` page per
 * column, with the relay's total as the column count.
 *
 * Moves go through `updateLead` and the relay decides legality. A move the
 * relay refuses renders its reason inline against the card; the client never
 * fabricates a generic failure. Converted is read-only in this phase: a Lead
 * cannot move into `active`, so the column is rendered without a move
 * control at all.
 */
export function PipelineWorkspace({
  dataSource,
  onOpenLead,
}: PipelineWorkspaceProps) {
  const [columns, setColumns] = React.useState<PipelineColumn[] | null>(null);
  const [error, setError] = React.useState<Error | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [movingLeadId, setMovingLeadId] = React.useState<string | null>(null);
  const [rejections, setRejections] = React.useState<Record<string, string>>(
    {},
  );

  React.useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void dataSource
      .getPipelineColumns()
      .then((next) => {
        if (cancelled) return;
        setColumns(next);
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataSource]);

  const moveLead = React.useCallback(
    async (lead: Lead, target: LeadFunnelStatus) => {
      setMovingLeadId(lead.id);
      setRejections((current) => {
        const { [lead.id]: _removed, ...rest } = current;
        return rest;
      });
      try {
        const receipt = await dataSource.updateLead(lead.id, {
          status: target,
        });
        setColumns((current) => {
          if (!current) return current;
          return current.map((column) => {
            if (column.status === lead.status) {
              return {
                ...column,
                leads: column.leads.filter(
                  (candidate) => candidate.id !== lead.id,
                ),
                total: Math.max(0, column.total - 1),
              };
            }
            if (column.status === target) {
              const alreadyThere = column.leads.some(
                (candidate) => candidate.id === lead.id,
              );
              return {
                ...column,
                leads: alreadyThere ? column.leads : [receipt, ...column.leads],
                total: column.total + 1,
              };
            }
            return column;
          });
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setRejections((current) => ({ ...current, [lead.id]: message }));
      } finally {
        setMovingLeadId(null);
      }
    },
    [dataSource],
  );

  if (error) {
    return (
      <Card className="border-border/60 bg-card/70 p-10 text-center shadow-none">
        <RefreshCw className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="mt-3 text-lg font-semibold text-foreground">
          Pipeline could not load
        </h2>
        <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
          {error.message}
        </p>
        <Button
          className="mt-4"
          onClick={() => window.location.reload()}
          type="button"
          variant="outline"
        >
          Reload discovery
        </Button>
      </Card>
    );
  }

  if (isLoading || !columns) {
    return (
      <div aria-busy="true" className="space-y-5">
        <div className="h-12 animate-pulse rounded-xl bg-muted/40" />
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-6">
          {["first", "second", "third", "fourth", "fifth", "sixth"].map(
            (key) => (
              <div
                className="h-96 animate-pulse rounded-xl bg-muted/35"
                key={key}
              />
            ),
          )}
        </div>
        <span className="sr-only">Loading the pipeline</span>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="pipeline-workspace">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/50 pb-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Pipeline.
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Move retained leads through the funnel. The relay enforces every
            transition and refuses moves it does not allow.
          </p>
        </div>
      </header>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-6">
        {columns.map((column) => (
          <PipelineColumnCard
            column={column}
            key={column.status}
            movingLeadId={movingLeadId}
            onMove={moveLead}
            onOpenLead={onOpenLead}
            rejections={rejections}
          />
        ))}
      </div>
    </div>
  );
}

function PipelineColumnCard({
  column,
  movingLeadId,
  onMove,
  onOpenLead,
  rejections,
}: {
  column: PipelineColumn;
  movingLeadId: string | null;
  onMove: (lead: Lead, target: LeadFunnelStatus) => void;
  onOpenLead: (leadId: string) => void;
  rejections: Record<string, string>;
}) {
  return (
    <section
      className="flex min-h-96 flex-col rounded-xl border border-border/60 bg-card/70 shadow-none"
      data-testid={`pipeline-column-${column.status}`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2.5">
        <h2 className="truncate text-sm font-semibold text-foreground">
          {PIPELINE_COLUMN_LABELS[column.status]}
        </h2>
        <Badge
          className="tabular-nums"
          data-testid={`pipeline-column-${column.status}-total`}
          variant="secondary"
        >
          {column.total}
        </Badge>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {column.leads.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No leads yet
          </p>
        ) : (
          column.leads.map((lead) => (
            <PipelineLeadCard
              key={lead.id}
              lead={lead}
              moving={movingLeadId === lead.id}
              onMove={(target) => onMove(lead, target)}
              onOpen={() => onOpenLead(lead.id)}
              rejection={rejections[lead.id]}
            />
          ))
        )}
        {column.total > column.leads.length ? (
          <p className="px-2 pt-1 text-center text-2xs text-muted-foreground">
            Showing first {column.leads.length} of {column.total}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function PipelineLeadCard({
  lead,
  moving,
  onMove,
  onOpen,
  rejection,
}: {
  lead: Lead;
  moving: boolean;
  onMove: (target: LeadFunnelStatus) => void;
  onOpen: () => void;
  rejection?: string;
}) {
  const targets = pipelineMoveTargets(lead.status);
  const readOnly = lead.status === "client_active";
  return (
    <div
      className="rounded-lg border border-border/60 bg-background p-3 shadow-none"
      data-testid={`pipeline-card-${lead.id}`}
    >
      <button
        className="block w-full truncate text-left text-sm font-medium text-foreground hover:text-primary"
        onClick={onOpen}
        title="Open lead details"
        type="button"
      >
        {lead.companyName}
      </button>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {lead.location}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-2xs text-muted-foreground">
          {lead.sourceLabel}
        </p>
        <span className="shrink-0 text-2xs font-medium tabular-nums text-muted-foreground">
          Score {lead.score}
        </span>
      </div>
      {!readOnly ? (
        <label className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ArrowRight aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span className="sr-only">Move {lead.companyName} to</span>
          <select
            aria-label={`Move ${lead.companyName} to`}
            className="min-w-0 flex-1 rounded-md border border-input/40 bg-background px-1.5 py-1 text-xs text-foreground outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
            data-testid={`pipeline-move-${lead.id}`}
            disabled={moving || targets.length === 0}
            onChange={(event) => {
              const target = event.target.value as LeadFunnelStatus;
              event.target.value = "";
              if (target) onMove(target);
            }}
            value=""
          >
            <option disabled value="">
              {targets.length === 0 ? "Terminal" : "Move..."}
            </option>
            {PIPELINE_COLUMN_STATUSES.map((status) => {
              if (status === lead.status || status === "client_active") {
                return null;
              }
              const legal = targets.includes(status);
              return (
                <option disabled={!legal} key={status} value={status}>
                  {PIPELINE_COLUMN_LABELS[status]}
                  {legal ? "" : " (not allowed)"}
                </option>
              );
            })}
          </select>
        </label>
      ) : null}
      {rejection ? (
        <p
          className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive"
          data-testid={`pipeline-rejection-${lead.id}`}
          role="alert"
        >
          {rejection}
        </p>
      ) : null}
    </div>
  );
}
