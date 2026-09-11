import * as React from "react";
import { ArrowDown, ArrowUp, Check, Search } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

import "./blockPresentation.css";
import {
  filterRows,
  formatBlockCell,
  resolveTableRows,
  stableSortRows,
} from "./resolvers";
import type { BlockTableColumn, BlockTableNode } from "./types";

export type BlockRowAction = { id: string; label: string };
type SortState = { key: string; direction: "ascending" | "descending" };

/** Small inline results stay quiet; larger datasets expose search and sorting. */
export function showBlockTableTools(rowCount: number): boolean {
  return rowCount > 12;
}

/** Numeric values align even when an older manifest did not declare a format. */
export function isBlockNumericColumn(
  column: BlockTableColumn,
  rows: readonly Record<string, unknown>[],
): boolean {
  if (column.format === "number" || column.format === "currency") return true;
  if (column.format && column.format !== "text") return false;
  const values = rows
    .map((row) => row[column.key])
    .filter((value) => value !== undefined && value !== null && value !== "");
  return (
    values.length > 0 && values.every((value) => typeof value === "number")
  );
}

function TableCellValue({
  value,
  column,
}: {
  value: unknown;
  column: BlockTableColumn;
}) {
  if (typeof value === "boolean")
    return (
      <span className="block-native-boolean text-xs" data-value={value}>
        {value ? (
          <Check aria-hidden="true" className="size-3.5 shrink-0" />
        ) : null}
        {value ? "Yes" : "No"}
      </span>
    );
  return (
    <span className="block-native-copy">
      {formatBlockCell(
        value,
        column.format ?? (typeof value === "number" ? "number" : "text"),
      )}
    </span>
  );
}

export function BlockTable({
  className,
  data,
  node,
  onRowAction,
  onSelectionChange,
  rowActions = [],
  selectionMode = "none",
}: {
  className?: string;
  data: unknown;
  node: BlockTableNode;
  onRowAction?: (actionId: string, row: Record<string, unknown>) => void;
  onSelectionChange?: (keys: ReadonlySet<string>) => void;
  rowActions?: readonly BlockRowAction[];
  selectionMode?: "none" | "single" | "multiple";
}) {
  const rows = React.useMemo(() => resolveTableRows(node, data), [data, node]);
  const rowKeys = React.useMemo(() => {
    const seen = new Map<string, number>();
    return new Map(
      rows.map((row, index) => {
        const candidate = row.id ?? row.key;
        const base =
          typeof candidate === "string" || typeof candidate === "number"
            ? String(candidate)
            : `row:${index}`;
        const occurrence = seen.get(base) ?? 0;
        seen.set(base, occurrence + 1);
        return [row, occurrence ? `${base}:${occurrence}` : base];
      }),
    );
  }, [rows]);
  const filterId = React.useId();
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortState | null>(null);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const tools = showBlockTableTools(rows.length);
  const visibleRows = React.useMemo(() => {
    const filtered = filterRows(rows, tools ? query : "");
    return tools && sort
      ? stableSortRows(filtered, sort.key, sort.direction)
      : filtered;
  }, [query, rows, sort, tools]);
  const select = (key: string) => {
    const next = new Set(selectionMode === "multiple" ? selected : []);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
    onSelectionChange?.(next);
  };

  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card text-card-foreground",
        className,
      )}
      data-block-primitive="table"
    >
      {tools ? (
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <label className="sr-only" htmlFor={filterId}>
            Filter table
          </label>
          <Search
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <input
            className="min-w-0 flex-1 rounded-sm bg-transparent text-sm outline-hidden placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            id={filterId}
            maxLength={120}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search this table…"
            type="search"
            value={query}
          />
        </div>
      ) : null}
      <section
        className="block-native-table-scroll outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={node.caption ?? "Block data table"}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable table must be reachable for keyboard scrolling.
        tabIndex={0}
      >
        <table className="block-native-table text-sm leading-relaxed">
          <caption className="sr-only">{node.caption ?? "Block data"}</caption>
          <thead className="text-xs font-medium text-muted-foreground">
            <tr>
              {selectionMode !== "none" ? (
                <th className="w-10" scope="col">
                  <span className="sr-only">Select row</span>
                </th>
              ) : null}
              {node.columns.map((column) => {
                const active = tools && sort?.key === column.key;
                const SortIcon =
                  sort?.direction === "ascending" ? ArrowUp : ArrowDown;
                return (
                  <th
                    aria-sort={
                      tools ? (active ? sort?.direction : "none") : undefined
                    }
                    data-numeric={isBlockNumericColumn(column, rows)}
                    key={column.key}
                    scope="col"
                  >
                    {tools ? (
                      <button
                        className="inline-flex max-w-full items-start gap-1.5 rounded-sm text-left font-medium outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() =>
                          setSort((current) => ({
                            key: column.key,
                            direction:
                              current?.key === column.key &&
                              current.direction === "ascending"
                                ? "descending"
                                : "ascending",
                          }))
                        }
                        type="button"
                      >
                        <span className="block-native-copy">
                          {column.label}
                        </span>
                        {active ? (
                          <SortIcon
                            aria-hidden="true"
                            className="mt-0.5 size-3.5 shrink-0"
                          />
                        ) : null}
                      </button>
                    ) : (
                      <span className="block-native-copy">{column.label}</span>
                    )}
                  </th>
                );
              })}
              {rowActions.length > 0 ? (
                <th className="text-right" scope="col">
                  Actions
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
              const key = rowKeys.get(row) ?? "";
              return (
                <tr key={key}>
                  {selectionMode !== "none" ? (
                    <td>
                      <input
                        aria-label={`Select row ${rows.indexOf(row) + 1}`}
                        checked={selected.has(key)}
                        name={
                          selectionMode === "single"
                            ? `${filterId}-selection`
                            : undefined
                        }
                        onChange={() => select(key)}
                        type={selectionMode === "single" ? "radio" : "checkbox"}
                      />
                    </td>
                  ) : null}
                  {node.columns.map((column, index) => (
                    <td
                      className={index === 0 ? "font-medium" : undefined}
                      data-numeric={isBlockNumericColumn(column, rows)}
                      key={column.key}
                    >
                      <TableCellValue value={row[column.key]} column={column} />
                    </td>
                  ))}
                  {rowActions.length > 0 ? (
                    <td className="text-right">
                      {rowActions.map((action) => (
                        <Button
                          className="h-auto max-w-full whitespace-normal"
                          key={action.id}
                          onClick={() => onRowAction?.(action.id, row)}
                          size="xs"
                          type="button"
                          variant="ghost"
                        >
                          {action.label}
                        </Button>
                      ))}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        {visibleRows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            {query && tools ? "No matching rows." : "No rows to show."}
          </p>
        ) : null}
      </section>
      <div className="flex flex-wrap justify-between gap-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
        <span aria-live="polite">
          {visibleRows.length}
          {tools && query ? ` of ${rows.length}` : ""}{" "}
          {rows.length === 1 ? "row" : "rows"}
        </span>
        {selectionMode === "none" && rowActions.length === 0 ? (
          <span>Read-only</span>
        ) : null}
      </div>
    </div>
  );
}
