import { Badge } from "@/shared/ui/badge";

import type { GateReport, GateResult } from "../contracts";
import { GATE_LABELS, missingGates } from "../contracts";

/**
 * The measured gate readouts for one card.
 *
 * Every AI social tool generates. The point of this panel is that ours
 * measures what it generated and says so in numbers a person can check, so the
 * numbers are shown verbatim rather than reduced to ticks. A gate that did not
 * run says "not run" in its own row, and a gate the report never mentioned
 * says "not reported": absence is a state with a name here, never a blank.
 */

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "–";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(formatValue).join(" × ");
  }
  return JSON.stringify(value);
}

/**
 * Render a bar in the operator it was written with.
 *
 * The bar carries its own operator so a floor, a range and an equality are one
 * type. Reading the operator here rather than hardcoding one phrasing per gate
 * is what lets a seventh gate appear with no change to this file.
 */
function formatBar(bar: unknown): string | null {
  if (typeof bar !== "object" || bar === null || Array.isArray(bar)) {
    return null;
  }
  const record = bar as Record<string, unknown>;
  const unit = typeof record.unit === "string" ? ` ${record.unit}` : "";
  switch (record.op) {
    case "gte":
      return `at least ${formatValue(record.value)}${unit}`;
    case "lte":
      return `at most ${formatValue(record.value)}${unit}`;
    case "between":
      return `${formatValue(record.min)} to ${formatValue(record.max)}${unit}`;
    case "equals":
      return `exactly ${formatValue(record.value)}${unit}`;
    default:
      return null;
  }
}

function statusBadge(status: GateResult["status"]) {
  if (status === "pass") {
    return <Badge variant="success">Pass</Badge>;
  }
  if (status === "fail") {
    return <Badge variant="destructive">Fail</Badge>;
  }
  return <Badge variant="warning">Not run</Badge>;
}

function GateRow({ gate }: { gate: GateResult }) {
  const bar = formatBar(gate.bar);
  const reason =
    gate.status === "skip" &&
    typeof gate.detail === "object" &&
    gate.detail !== null &&
    typeof (gate.detail as Record<string, unknown>).reason === "string"
      ? ((gate.detail as Record<string, unknown>).reason as string)
      : null;

  return (
    <li className="flex items-start justify-between gap-3 border-b border-border/40 py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {GATE_LABELS[gate.id] ?? gate.id}
        </p>
        <p className="text-xs text-muted-foreground">
          {gate.status === "skip"
            ? (reason ?? "Nothing measured this.")
            : `${formatValue(gate.measured)}${bar ? ` against ${bar}` : ""}`}
        </p>
      </div>
      {statusBadge(gate.status)}
    </li>
  );
}

export function ContentChecksPanel({ reports }: { reports: GateReport[] }) {
  const absent = missingGates(reports);

  if (reports.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
        <p className="text-sm font-medium">Nothing measured</p>
        <p className="mt-1 text-xs text-muted-foreground">
          This card has not been rendered, so no check has run on it.
        </p>
      </div>
    );
  }

  // Show the first report's metadata; the gates from all reports are merged.
  const firstReport = reports[0];
  const engine =
    firstReport.renderer && typeof firstReport.renderer.engine === "string"
      ? firstReport.renderer.engine
      : null;
  const allGates = reports.flatMap((report) => report.gates);
  const verdict = reports.every((report) => report.verdict === "pass")
    ? "pass"
    : reports.some((report) => report.verdict === "fail")
      ? "fail"
      : "incomplete";

  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">Checks</p>
        {verdict === "pass" ? (
          <Badge variant="success">All passed</Badge>
        ) : verdict === "fail" ? (
          <Badge variant="destructive">Failed</Badge>
        ) : (
          <Badge variant="warning">Not fully checked</Badge>
        )}
      </div>

      <ul className="mt-2">
        {allGates.map((gate) => (
          <GateRow gate={gate} key={gate.id} />
        ))}
        {absent.map((id) => (
          <li
            className="flex items-start justify-between gap-3 border-b border-border/40 py-2 last:border-b-0"
            key={`missing-${id}`}
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {GATE_LABELS[id] ?? id}
              </p>
              <p className="text-xs text-muted-foreground">
                The render never reported this check.
              </p>
            </div>
            <Badge variant="outline">Not reported</Badge>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs text-muted-foreground">
        Measured on these exact bytes
        {engine ? ` by ${engine}` : ""}
        {firstReport.renderedAt ? `, ${firstReport.renderedAt}` : ""}.
      </p>
    </div>
  );
}
