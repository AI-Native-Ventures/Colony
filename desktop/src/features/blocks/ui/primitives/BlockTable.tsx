import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

import {
  filterRows,
  formatBlockCell,
  resolveTableRows,
  stableSortRows,
} from "./resolvers";
import type { BlockTableNode } from "./types";

export type BlockRowAction = {
  id: string;
  label: string;
};

type SortState = {
  key: string;
  direction: "ascending" | "descending";
};

function rowKey(row: Record<string, unknown>, index: number): string {
  const candidate = row.id ?? row.key;
  return typeof candidate === "string" || typeof candidate === "number"
    ? String(candidate)
    : String(index);
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
  const filterId = React.useId();
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortState | null>(null);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const visibleRows = React.useMemo(() => {
    const filtered = filterRows(rows, query);
    return sort ? stableSortRows(filtered, sort.key, sort.direction) : filtered;
  }, [query, rows, sort]);

  const select = React.useCallback(
    (key: string) => {
      const next = new Set(selectionMode === "multiple" ? selected : []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setSelected(next);
      onSelectionChange?.(next);
    },
    [onSelectionChange, selected, selectionMode],
  );

  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border border-border/60",
        className,
      )}
      data-block-primitive="table"
    >
      <div className="flex items-center gap-2 border-b border-border/50 bg-muted/20 px-3 py-2">
        <label className="sr-only" htmlFor={filterId}>
          Filter table
        </label>
        <Search aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        <input
          className="min-w-0 flex-1 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
          id={filterId}
          maxLength={120}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Filter rows"
          type="search"
          value={query}
        />
      </div>
      <div className="max-w-full overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{node.caption ?? "Block data"}</caption>
          <thead className="bg-muted/30 text-xs font-medium text-muted-foreground">
            <tr>
              {selectionMode !== "none" ? (
                <th className="w-10 px-3 py-2" scope="col">
                  <span className="sr-only">Select row</span>
                </th>
              ) : null}
              {node.columns.map((column) => {
                const active = sort?.key === column.key;
                const SortIcon = !active
                  ? ChevronsUpDown
                  : sort.direction === "ascending"
                    ? ArrowUp
                    : ArrowDown;
                return (
                  <th
                    aria-sort={active ? sort.direction : "none"}
                    className="whitespace-nowrap px-3 py-2"
                    key={column.key}
                    scope="col"
                  >
                    <button
                      className="inline-flex items-center gap-1 rounded-sm font-medium outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
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
                      {column.label}
                      <SortIcon aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  </th>
                );
              })}
              {rowActions.length > 0 ? (
                <th className="px-3 py-2 text-right" scope="col">
                  Actions
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {visibleRows.map((row, index) => {
              const key = rowKey(row, index);
              return (
                <tr className="hover:bg-muted/20" key={key}>
                  {selectionMode !== "none" ? (
                    <td className="px-3 py-2">
                      <input
                        aria-label={`Select row ${index + 1}`}
                        checked={selected.has(key)}
                        name={
                          selectionMode === "single"
                            ? "block-table-selection"
                            : undefined
                        }
                        onChange={() => select(key)}
                        type={selectionMode === "single" ? "radio" : "checkbox"}
                      />
                    </td>
                  ) : null}
                  {node.columns.map((column) => (
                    <td
                      className="max-w-80 px-3 py-2 align-top text-foreground"
                      key={column.key}
                    >
                      <span className="line-clamp-3 break-words">
                        {formatBlockCell(row[column.key], column.format)}
                      </span>
                    </td>
                  ))}
                  {rowActions.length > 0 ? (
                    <td className="whitespace-nowrap px-3 py-1.5 text-right">
                      {rowActions.map((action) => (
                        <Button
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
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No rows to show.
          </p>
        ) : null}
      </div>
    </div>
  );
}
