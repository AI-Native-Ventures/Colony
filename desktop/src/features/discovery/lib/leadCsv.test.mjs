import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeCsvCell, leadCsvFilename, leadsToCsv } from "./leadCsv.ts";

function lead(overrides = {}) {
  return {
    id: "lead-1",
    companyName: "Tennant Group",
    contacts: 2,
    location: "Cape Town",
    source: "google_maps",
    sourceLabel: "Google Maps",
    score: 0,
    industryId: "prof-services",
    verticalId: "legal",
    campaignIds: [],
    status: "new",
    addedAt: "2026-08-04T09:00:00Z",
    ...overrides,
  };
}

test("a plain cell is written unchanged", () => {
  assert.equal(escapeCsvCell("Tennant Group"), "Tennant Group");
  assert.equal(escapeCsvCell(""), "");
});

test("a comma is quoted so the row keeps its columns", () => {
  // Without this, "Acme, Inc." becomes two cells and every field after it on
  // the row lands under the wrong header.
  assert.equal(escapeCsvCell("Acme, Inc."), '"Acme, Inc."');
});

test("an embedded quote is doubled, not dropped", () => {
  assert.equal(escapeCsvCell('The "Real" Co'), '"The ""Real"" Co"');
});

test("a newline inside a cell is quoted rather than splitting the row", () => {
  assert.equal(escapeCsvCell("Line one\nLine two"), '"Line one\nLine two"');
  assert.equal(escapeCsvCell("Line one\r\nLine two"), '"Line one\r\nLine two"');
});

test("a formula-leading cell is neutralized", () => {
  // A spreadsheet executes a cell starting with =, +, - or @ on open. An
  // export is not a place to hand somebody else's data execution rights.
  assert.equal(escapeCsvCell("=1+1"), "'=1+1");
  assert.equal(escapeCsvCell("+27 21 555 0100"), "'+27 21 555 0100");
  assert.equal(escapeCsvCell("-lead"), "'-lead");
  assert.equal(escapeCsvCell("@handle"), "'@handle");
  // Neutralizing must still quote when the value also needs quoting.
  assert.equal(escapeCsvCell("=a,b"), `"'=a,b"`);
});

test("the file carries a header row and one row per lead", () => {
  const csv = leadsToCsv([
    lead(),
    lead({ id: "lead-2", companyName: "Horizon" }),
  ]);
  const rows = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^Company,Contact,Title,Email,Phone,Website/);
  assert.match(rows[1], /^Tennant Group,/);
  assert.match(rows[2], /^Horizon,/);
});

test("the file opens with a byte order mark and uses CRLF", () => {
  // Excel on Windows reads a UTF-8 file as the local codepage without a BOM
  // and mangles every non-ASCII company name.
  const csv = leadsToCsv([lead({ companyName: "Café Ubuntu" })]);
  assert.ok(csv.startsWith("﻿"), "must begin with a BOM");
  assert.ok(csv.includes("\r\n"), "rows must be CRLF-terminated");
  assert.ok(csv.includes("Café Ubuntu"));
});

test("an empty selection still produces a usable file", () => {
  // A header-only file says "nothing matched" clearly; a zero-byte file
  // looks like the export failed.
  const csv = leadsToCsv([]);
  const rows = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
  assert.equal(rows.length, 1);
  assert.match(rows[0], /^Company,/);
});

test("a person lead falls back to its person fields", () => {
  const csv = leadsToCsv([
    lead({
      companyName: "",
      company: "Horizon Labs",
      personName: "Ada Mokoena",
      roleName: "Head of Legal",
    }),
  ]);
  assert.ok(csv.includes("Horizon Labs,Ada Mokoena,Head of Legal"));
});

test("a missing optional field becomes an empty cell, never the word undefined", () => {
  const csv = leadsToCsv([lead()]);
  assert.ok(!csv.includes("undefined"));
  assert.ok(!csv.includes("null"));
});

test("the filename says what was exported and when", () => {
  const at = new Date("2026-08-04T09:30:15Z");
  assert.equal(
    leadCsvFilename("Legal — Cape Town", at),
    "legal-cape-town-2026-08-04T09-30-15.csv",
  );
  // A scope with no usable characters still yields a valid name.
  assert.equal(leadCsvFilename("!!!", at), "leads-2026-08-04T09-30-15.csv");
});
