import * as React from "react";

import {
  decisionLogsFromEvents,
  filterDecisionLogs,
  type DecisionLog,
} from "@/features/asks/lib/decisionLog";
import { decidedTotalNanoUsd } from "@/features/asks/lib/grantSpend";
import { useDecisionLogEventsQuery } from "@/features/asks/useDecisionLogEvents";
import { formatNanousdAsUsd } from "@/shared/api/tauriProvisionedCredits";
import type { RelayEvent } from "@/shared/api/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";

/**
 * The community's decision log (kind 44303), newest first, filterable by
 * deciding agent, grant, and category.
 *
 * Every stored log passed ingest's authority gate, so this view audits what
 * was decided -- it does not re-litigate who was allowed to decide. The undo
 * path leads each row: it is the only field the owner acts on, and burying
 * it behind the narrative would invert the record's purpose.
 *
 * The events come from the shared query the delegated authority section also
 * reads, so the running totals shown there and the rows listed here are the
 * same record, fetched once.
 */

const EMPTY_EVENTS: RelayEvent[] = [];
const EMPTY_LOGS: DecisionLog[] = [];
const EMPTY_NAMES: Record<string, string> = {};

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatLoggedAt(createdAt: number): string {
  return DATE_FORMAT.format(new Date(createdAt * 1_000));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

type FilterSelectProps = {
  children: React.ReactNode;
  label: string;
  onChange: (value: string) => void;
  testId: string;
  value: string;
};

function FilterSelect({
  children,
  label,
  onChange,
  testId,
  value,
}: FilterSelectProps) {
  return (
    <select
      aria-label={label}
      className="h-8 max-w-44 rounded-md border border-border bg-background px-2 text-xs text-foreground"
      data-testid={testId}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {children}
    </select>
  );
}

export function DecisionLogDialog({
  agentNames = EMPTY_NAMES,
  communityId,
  initialAgentPubkey = null,
  onOpenChange,
  open,
}: {
  /** Display names by pubkey, for readable agent labels and filter options. */
  agentNames?: Record<string, string>;
  communityId: string;
  /** Preselects the agent filter; "All agents" clears it to see everyone. */
  initialAgentPubkey?: string | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const logsQuery = useDecisionLogEventsQuery({ communityId, enabled: open });

  // Filter selections reset per mount: callers render this dialog only while
  // open, so reopening an agent's log starts scoped to that agent again.
  const [agentFilter, setAgentFilter] = React.useState(
    () => initialAgentPubkey?.trim() ?? "",
  );
  const [grantFilter, setGrantFilter] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState("");

  const logs = React.useMemo(
    () => decisionLogsFromEvents(logsQuery.data ?? EMPTY_EVENTS),
    [logsQuery.data],
  );
  const grantOptions = React.useMemo(
    () => uniqueSorted(logs.map((log) => log.grantId)),
    [logs],
  );
  const categoryOptions = React.useMemo(
    () => uniqueSorted(logs.map((log) => log.category)),
    [logs],
  );
  const visibleLogs = React.useMemo(
    () =>
      filterDecisionLogs(logs, {
        agentPubkey: agentFilter,
        category: categoryFilter,
        grantId: grantFilter,
      }),
    [agentFilter, categoryFilter, grantFilter, logs],
  );
  // Hoisted so a fully-filtered render reuses one array identity.
  const displayLogs = visibleLogs.length > 0 ? visibleLogs : EMPTY_LOGS;
  // Summed as bigint: nanoUSD totals outrun a JS number's exact range.
  const shownTotalNanoUsd = React.useMemo(
    () => decidedTotalNanoUsd(displayLogs),
    [displayLogs],
  );

  const agentOptions = React.useMemo(
    () =>
      uniqueSorted(logs.map((log) => normalizePubkey(log.agentPubkey))).map(
        (pubkey) => ({
          label: agentNames[pubkey] ?? truncatePubkey(pubkey),
          value: pubkey,
        }),
      ),
    [agentNames, logs],
  );

  const isLoading = logsQuery.isLoading;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-h-[80vh] sm:max-w-lg"
        data-testid="decision-log-dialog"
      >
        <DialogHeader>
          <DialogTitle>Decision log</DialogTitle>
          <DialogDescription>
            Decisions made under delegated authority, newest first. Each row
            leads with its undo path: that is the part you would act on.
          </DialogDescription>
        </DialogHeader>

        <div
          className="flex flex-wrap items-center gap-2"
          data-testid="decision-log-filters"
        >
          <FilterSelect
            label="All agents"
            onChange={setAgentFilter}
            testId="decision-log-filter-agent"
            value={agentFilter}
          >
            <option value="">All agents</option>
            {agentOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="All grants"
            onChange={setGrantFilter}
            testId="decision-log-filter-grant"
            value={grantFilter}
          >
            <option value="">All grants</option>
            {grantOptions.map((grant) => (
              <option key={grant} value={grant}>
                {grant}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="All categories"
            onChange={setCategoryFilter}
            testId="decision-log-filter-category"
            value={categoryFilter}
          >
            <option value="">All categories</option>
            {categoryOptions.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </FilterSelect>
        </div>

        {isLoading ? (
          <div
            className="h-24 animate-pulse rounded-xl bg-muted/40"
            data-testid="decision-log-loading"
          />
        ) : logs.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="decision-log-empty"
          >
            No decisions have been recorded yet. Agents escalate anything they
            cannot decide or undo.
          </p>
        ) : displayLogs.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="decision-log-filtered-empty"
          >
            No decisions match these filters.
          </p>
        ) : (
          <>
            <p
              className="text-xs text-muted-foreground"
              data-testid="decision-log-total"
            >
              {displayLogs.length === 1
                ? "1 decision"
                : `${displayLogs.length} decisions`}{" "}
              shown, {formatNanousdAsUsd(shownTotalNanoUsd.toString())} in
              total. A delegation's limit is checked one decision at a time, so
              nothing held this total down.
            </p>
            <ul
              className="-mr-2 max-h-[52vh] space-y-2 overflow-y-auto pr-2"
              data-testid="decision-log-list"
            >
              {displayLogs.map((log) => (
                <DecisionLogRow
                  agentLabel={
                    agentNames[log.agentPubkey] ??
                    truncatePubkey(log.agentPubkey)
                  }
                  key={log.eventId}
                  log={log}
                />
              ))}
            </ul>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DecisionLogRow({
  agentLabel,
  log,
}: {
  agentLabel: string;
  log: DecisionLog;
}) {
  return (
    <li
      className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
      data-testid={`decision-log-row-${log.eventId}`}
    >
      {/* Primary content: what the owner acts on to reverse the decision. */}
      <p
        className="break-words font-mono text-sm font-medium text-foreground"
        data-testid={`decision-log-undo-${log.eventId}`}
      >
        {log.undoPath}
      </p>
      <p
        className="mt-1 break-words text-xs text-muted-foreground"
        data-testid={`decision-log-decision-${log.eventId}`}
      >
        {log.decision}
      </p>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-2xs text-muted-foreground">
        <span data-testid={`decision-log-agent-${log.eventId}`}>
          {agentLabel}
        </span>
        <span aria-hidden="true">·</span>
        <span
          className="font-mono"
          data-testid={`decision-log-grant-${log.eventId}`}
        >
          {log.grantId}
        </span>
        <span aria-hidden="true">·</span>
        <span>{log.category}</span>
        {log.amountNanoUsd !== null ? (
          <>
            <span aria-hidden="true">·</span>
            <span data-testid={`decision-log-amount-${log.eventId}`}>
              {formatNanousdAsUsd(String(log.amountNanoUsd))}
            </span>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        <time dateTime={new Date(log.createdAt * 1_000).toISOString()}>
          {formatLoggedAt(log.createdAt)}
        </time>
      </p>
    </li>
  );
}
