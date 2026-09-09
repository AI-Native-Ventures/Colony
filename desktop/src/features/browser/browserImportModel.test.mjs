import assert from "node:assert/strict";
import test from "node:test";
import {
  describeBrowserImport,
  filterImportSites,
  importSelectedSites,
  selectImportSites,
} from "./browserImportModel.ts";

const result = (overrides = {}) => ({
  imported: 0,
  skipped: 0,
  preserved: 0,
  failed: 0,
  status: "needs-verification",
  ...overrides,
});

test("selecting search matches keeps existing hidden selections without duplicates", () => {
  const sites = [".instagram.com", ".accounts.instagram.com", ".example.com"];
  const visible = filterImportSites(sites, "  INSTAGRAM ");
  assert.deepEqual(visible, [".instagram.com", ".accounts.instagram.com"]);
  assert.deepEqual(
    selectImportSites([".example.com", ".instagram.com"], visible),
    [".example.com", ".instagram.com", ".accounts.instagram.com"],
  );
  assert.deepEqual(filterImportSites(sites, " "), sites);
  assert.deepEqual(filterImportSites(sites, "not-here"), []);
});

test("the reported zero-copy screenshot explains preserved data and how to refresh it", () => {
  const summary = describeBrowserImport(
    result({ preserved: 336, skipped: 28 }),
  );
  assert.equal(summary.title, "No new sign-in data copied");
  assert.match(
    summary.detail,
    /kept existing sign-in data for these sites because replacement was turned off/,
  );
  assert.match(
    summary.detail,
    /does not tell us whether you are still signed in/,
  );
  assert.match(
    summary.nextStep,
    /select that site, turn on Replace existing sign-ins/,
  );
});

test("copied data still requires website verification, and failures are not called success", () => {
  const copied = describeBrowserImport(result({ imported: 22 }));
  assert.equal(copied.title, "Sign-in data copied");
  assert.match(copied.detail, /accounts still need to be checked/);
  assert.equal(
    describeBrowserImport(result({ imported: 20, failed: 2 })).title,
    "Some sign-in data could not be copied",
  );
  assert.equal(
    describeBrowserImport(result({ failed: 2 })).title,
    "No new sign-in data copied",
  );
  assert.equal(
    describeBrowserImport(result({ skipped: 28 })).title,
    "No sign-in data could be imported",
  );
  assert.match(
    describeBrowserImport(result()).detail,
    /No usable sign-in data/,
  );
  assert.equal(
    describeBrowserImport(result({ imported: 2, status: "interrupted" })).title,
    "Import stopped before it finished",
  );
});

test("Select all can import more than 100 sites while native requests stay bounded and sequential", async () => {
  const hosts = Array.from(
    { length: 205 },
    (_, index) => `.site-${index}.test`,
  );
  const batches = [];
  const progress = [];
  let inFlight = false;
  const totals = await importSelectedSites({
    hosts: [...hosts, hosts[0]],
    isCurrent: () => true,
    onProgress: (done, total) => progress.push([done, total]),
    run: async (batch) => {
      assert.equal(inFlight, false);
      inFlight = true;
      await Promise.resolve();
      batches.push(batch);
      inFlight = false;
      return result({ imported: batch.length, preserved: 2, skipped: 1 });
    },
  });
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 5],
  );
  assert.deepEqual(batches.flat(), hosts);
  assert.deepEqual(progress, [
    [100, 205],
    [200, 205],
    [205, 205],
  ]);
  assert.deepEqual(totals, result({ imported: 205, preserved: 6, skipped: 3 }));
});

test("an interrupted native batch stops later imports and keeps partial counts", async () => {
  let calls = 0;
  const totals = await importSelectedSites({
    hosts: Array.from({ length: 250 }, (_, index) => `.site-${index}.test`),
    isCurrent: () => true,
    onProgress: () => {},
    run: async () => {
      calls++;
      return calls === 1
        ? result({ imported: 100 })
        : result({ imported: 7, failed: 2, status: "interrupted" });
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(
    totals,
    result({ imported: 107, failed: 2, status: "interrupted" }),
  );
});

test("closing the importer or changing business stops subsequent batches", async () => {
  let current = true;
  let calls = 0;
  const totals = await importSelectedSites({
    hosts: Array.from({ length: 101 }, (_, index) => `.site-${index}.test`),
    isCurrent: () => current,
    onProgress: () => {},
    run: async () => {
      calls++;
      current = false;
      return result({ preserved: 100 });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(totals, result({ preserved: 100, status: "interrupted" }));
});

test("later request failure does not lose earlier totals; first request errors remain actionable", async () => {
  let calls = 0;
  const totals = await importSelectedSites({
    hosts: Array.from({ length: 101 }, (_, index) => `.site-${index}.test`),
    isCurrent: () => true,
    onProgress: () => {},
    run: async () => {
      if (++calls === 2) throw new Error("Connection lost");
      return result({ imported: 100 });
    },
  });
  assert.deepEqual(totals, result({ imported: 100, status: "interrupted" }));
  await assert.rejects(
    importSelectedSites({
      hosts: [".example.com"],
      isCurrent: () => true,
      onProgress: () => {},
      run: async () => {
        throw new Error("Keychain access cancelled");
      },
    }),
    /Keychain access cancelled/,
  );
});
