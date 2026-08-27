import assert from "node:assert/strict";
import { test } from "node:test";

import { provisionWorkspace } from "./provisionWorkspace.ts";

const created = (slug) => ({
  community: { id: `id-${slug}`, slug, normalized_host: `${slug}.colony.test` },
});

test("creates on the first available candidate", async () => {
  const tried = [];
  const outcome = await provisionWorkspace("Acme Co", null, {
    check: async (name) => {
      tried.push(name);
      return { available: name !== "acme-co" };
    },
    create: async (name) => created(name),
    listMine: async () => ({ communities: [] }),
  });
  assert.deepEqual(tried, ["acme-co", "acme-co-2"]);
  assert.deepEqual(outcome, {
    ok: true,
    slug: "acme-co-2",
    relayUrl: "wss://acme-co-2.colony.test",
    communityId: "id-acme-co-2",
  });
});

test("a race on create falls through to the next candidate", async () => {
  const outcome = await provisionWorkspace("Acme", null, {
    check: async () => ({ available: true }),
    create: async (name) => {
      if (name === "acme") throw new Error("taken");
      return created(name);
    },
    listMine: async () => ({ communities: [] }),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.slug, "acme-2");
});

test("Tauri string rejections are classified like Error rejections", async () => {
  // The native bridge rejects with the Err(String) payload itself, not an
  // Error instance; classification must not depend on the rejection type.
  const outcome = await provisionWorkspace("Acme", null, {
    check: async () => ({ available: true }),
    create: async (name) => {
      if (name === "acme") throw "taken";
      return created(name);
    },
    listMine: async () => ({ communities: [] }),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.slug, "acme-2");
});

test("resume: a stored slug the account already owns is reused, not recreated", async () => {
  let createCalls = 0;
  const outcome = await provisionWorkspace("Acme", "acme", {
    check: async () => ({ available: false }),
    create: async () => {
      createCalls += 1;
      return created("never");
    },
    listMine: async () => ({
      communities: [
        {
          slug: "acme",
          normalized_host: "acme.colony.test",
          archived_at: null,
        },
      ],
    }),
  });
  assert.equal(createCalls, 0);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.relayUrl, "wss://acme.colony.test");
});

test("limit errors are terminal, not retried through candidates", async () => {
  let createCalls = 0;
  const outcome = await provisionWorkspace("Acme", null, {
    check: async () => ({ available: true }),
    create: async () => {
      createCalls += 1;
      throw new Error("limit_reached");
    },
    listMine: async () => ({ communities: [] }),
  });
  assert.equal(createCalls, 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "limit");
});

test("every candidate taken reports exhausted", async () => {
  const outcome = await provisionWorkspace("Acme", null, {
    check: async () => ({ available: false }),
    create: async () => created("x"),
    listMine: async () => ({ communities: [] }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "exhausted");
});

test("network failure on check reports unreachable", async () => {
  const outcome = await provisionWorkspace("Acme", null, {
    check: async () => {
      throw new Error("fetch failed");
    },
    create: async () => created("x"),
    listMine: async () => ({ communities: [] }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "unreachable");
});
