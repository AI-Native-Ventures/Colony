import { invokeTauri } from "@/shared/api/tauri";

import type { Lead } from "../types";
import { leadCsvFilename, leadsToCsv } from "./leadCsv";

/**
 * Writing the leads currently in view to a file.
 *
 * The renderer builds the CSV because it holds the leads and the filters the
 * person is looking at; the Tauri side owns the filesystem and the native
 * save dialog.
 */

/** What happened, in terms the workspace can show verbatim. */
export type ExportOutcome =
  | { kind: "saved"; count: number }
  | { kind: "cancelled" }
  | { kind: "empty" }
  | { kind: "failed"; message: string };

/**
 * Export `leads` as CSV through the native save dialog.
 *
 * Cancelling is a normal outcome, not a failure: a person who changes their
 * mind should not be shown an error. An empty selection is also called out
 * rather than silently writing a header-only file, because "nothing matched
 * your filters" is what they actually need to know.
 */
export async function exportLeadsToCsv(
  leads: readonly Lead[],
  scopeLabel: string,
  takenAt: Date = new Date(),
): Promise<ExportOutcome> {
  if (leads.length === 0) {
    return { kind: "empty" };
  }
  try {
    const saved = await invokeTauri<boolean>("save_leads_csv", {
      csv: leadsToCsv(leads),
      filename: leadCsvFilename(scopeLabel, takenAt),
    });
    return saved
      ? { kind: "saved", count: leads.length }
      : { kind: "cancelled" };
  } catch (error) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The sentence to show for an outcome. */
export function describeExportOutcome(
  outcome: ExportOutcome,
  noun: string,
): string | null {
  switch (outcome.kind) {
    case "saved":
      return `Exported ${outcome.count} ${noun}.`;
    case "empty":
      return `No ${noun} match the current filters, so there was nothing to export.`;
    case "failed":
      return `Export failed: ${outcome.message}`;
    // Cancelling is not worth a message.
    case "cancelled":
      return null;
  }
}
