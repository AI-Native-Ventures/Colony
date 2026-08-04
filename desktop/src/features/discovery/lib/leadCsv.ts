import type { Lead } from "../types";

/**
 * Exporting leads as CSV.
 *
 * The point of an export is that the numbers and names survive the trip into
 * whatever the reader opens it with, so the escaping rules below are the
 * whole substance of this module rather than an afterthought.
 */

/** One column, and how to read it off a lead. */
type Column = {
  /** Header text. */
  header: string;
  /** The cell value, or an empty string when the lead has none. */
  read: (lead: Lead) => string;
};

/**
 * Columns, in the order a reader expects them: who it is, how to reach them,
 * then where it came from and what we think of it.
 */
const COLUMNS: readonly Column[] = [
  { header: "Company", read: (lead) => lead.companyName || lead.company || "" },
  {
    header: "Contact",
    read: (lead) => lead.contactName ?? lead.personName ?? "",
  },
  { header: "Title", read: (lead) => lead.contactTitle ?? lead.roleName ?? "" },
  { header: "Email", read: (lead) => lead.email ?? "" },
  { header: "Phone", read: (lead) => lead.phone ?? "" },
  { header: "Website", read: (lead) => lead.website ?? "" },
  { header: "LinkedIn", read: (lead) => lead.linkedinUrl ?? "" },
  { header: "Location", read: (lead) => lead.location ?? "" },
  { header: "Source", read: (lead) => lead.sourceLabel || lead.source || "" },
  { header: "Status", read: (lead) => lead.status ?? "" },
  { header: "Score", read: (lead) => String(lead.score ?? "") },
  { header: "Owner", read: (lead) => lead.owner ?? "" },
  { header: "Added", read: (lead) => lead.addedAt ?? "" },
];

/**
 * Escape one cell.
 *
 * Quotes whenever the value contains a comma, a quote, or a newline, and
 * doubles any embedded quote, per RFC 4180. Without this a single company
 * name like `Acme, Inc.` silently becomes two columns and every field after
 * it on that row lands under the wrong header.
 *
 * A leading `=`, `+`, `-` or `@` is also prefixed with a quote character,
 * because spreadsheets treat those as the start of a formula. A lead named
 * `=cmd|...` is a live formula the moment the file is opened, and the export
 * is not a place to hand somebody else's data execution rights.
 */
export function escapeCsvCell(value: string): string {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(neutralized)) {
    return `"${neutralized.replaceAll('"', '""')}"`;
  }
  return neutralized;
}

/**
 * Render leads as an RFC 4180 CSV.
 *
 * Rows are CRLF-terminated and the file opens with a UTF-8 byte order mark,
 * because Excel on Windows otherwise reads a UTF-8 file as the local
 * codepage and mangles every non-ASCII company name.
 */
export function leadsToCsv(leads: readonly Lead[]): string {
  const rows = [COLUMNS.map((column) => escapeCsvCell(column.header))];
  for (const lead of leads) {
    rows.push(COLUMNS.map((column) => escapeCsvCell(column.read(lead) ?? "")));
  }
  return `﻿${rows.map((row) => row.join(",")).join("\r\n")}\r\n`;
}

/**
 * A filename that says what the export contains and when it was taken.
 *
 * Two exports of different filters would otherwise overwrite each other in
 * the download folder.
 */
export function leadCsvFilename(scopeLabel: string, takenAt: Date): string {
  const stamp = takenAt.toISOString().slice(0, 19).replaceAll(":", "-");
  const slug =
    scopeLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "leads";
  return `${slug}-${stamp}.csv`;
}
