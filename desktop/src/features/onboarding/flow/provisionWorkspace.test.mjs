import assert from "node:assert/strict";
import { test } from "node:test";

import {
  provisionWorkspace,
  expectedWorkspaceApplied,
} from "./provisionWorkspace.ts";

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

test("a race on create never allocates a second candidate", async () => {
  const outcome = await provisionWorkspace("Acme", null, {
    check: async () => ({ available: true }),
    create: async (name) => {
      if (name === "acme") throw new Error("taken");
      return created(name);
    },
    listMine: async () => ({ communities: [] }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "exhausted");
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
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "exhausted");
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

test("an accepted create with a lost response resumes the remembered candidate", async () => {
  let remembered = null;
  let creates = 0;
  let owned = [];
  const api = {
    check: async () => ({ available: true }),
    listMine: async () => ({ communities: owned }),
    create: async (slug) => {
      creates += 1;
      owned = [created(slug).community];
      throw new Error("response lost");
    },
  };
  assert.equal(
    (
      await provisionWorkspace("Horizon", null, api, (slug) => {
        remembered = slug;
      })
    ).ok,
    false,
  );
  const resumed = await provisionWorkspace("Renamed business", remembered, api);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.slug, "horizon");
  assert.equal(creates, 1);
});
test("an uncertain candidate never advances when ownership has not caught up", async () => {
  let creates = 0;
  const outcome = await provisionWorkspace("Horizon", "horizon", {
    listMine: async () => ({ communities: [] }),
    check: async () => ({ available: false }),
    create: async () => {
      creates += 1;
      return created("duplicate");
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(creates, 0);
});
test("failure to persist a create candidate prevents its network write", async () => {
  let creates = 0;
  const outcome = await provisionWorkspace(
    "Horizon",
    null,
    {
      listMine: async () => ({ communities: [] }),
      check: async () => ({ available: true }),
      create: async () => {
        creates += 1;
        return created("horizon");
      },
    },
    () => {
      throw new Error("storage unavailable");
    },
  );
  assert.equal(outcome.ok, false);
  assert.equal(creates, 0);
});

test("a prior applied community cannot satisfy the new business handoff", () => {
  assert.equal(
    expectedWorkspaceApplied("wss://new.test", "wss://previous.test", true),
    false,
  );
  assert.equal(
    expectedWorkspaceApplied("wss://new.test", "wss://new.test", false),
    false,
  );
  assert.equal(
    expectedWorkspaceApplied("wss://new.test", "wss://new.test", true),
    true,
  );
  assert.equal(
    expectedWorkspaceApplied(null, "wss://previous.test", true),
    false,
  );
});

test("a definitive create collision releases the candidate before the edited-name retry", async () => {
  let remembered = null;
  const tried = [];
  const remember = (slug) => {
    remembered = slug;
  };
  const api = {
    listMine: async () => ({ communities: [] }),
    check: async (name) => {
      tried.push(name);
      return { available: true };
    },
    create: async (name) => {
      if (name === "first-company") throw new Error("taken");
      return created(name);
    },
  };
  const first = await provisionWorkspace(
    "First company",
    remembered,
    api,
    remember,
  );
  assert.equal(first.reason, "exhausted");
  assert.equal(remembered, null);
  const corrected = await provisionWorkspace(
    "Different company",
    remembered,
    api,
    remember,
  );
  assert.equal(corrected.ok, true);
  assert.deepEqual(tried, ["first-company", "different-company"]);
});

test("a collision whose ownership check fails retains the uncertain candidate", async () => {
  let remembered = null;
  const result = await provisionWorkspace(
    "First company",
    null,
    {
      listMine: async () => {
        throw new Error("ownership unavailable");
      },
      check: async () => ({ available: true }),
      create: async () => {
        throw new Error("taken");
      },
    },
    (slug) => {
      remembered = slug;
    },
  );
  assert.equal(result.reason, "unreachable");
  assert.equal(remembered, "first-company");
});

test("a taken claim retains its candidate when ownership data is incomplete", async () => {
  for (const mine of [
    {},
    { communities: null },
    { communities: [null] },
    { communities: [{ id: "incomplete-entry" }] },
    { communities: [{ slug: "horizon", id: "owned-id" }] },
  ]) {
    let remembered = null;
    const outcome = await provisionWorkspace(
      "Horizon",
      null,
      {
        check: async () => ({ available: true }),
        create: async () => {
          throw new Error("taken");
        },
        listMine: async () => mine,
      },
      (slug) => {
        remembered = slug;
      },
    );
    assert.equal(outcome.reason, "unreachable");
    assert.equal(remembered, "horizon");
  }
});

test("an incomplete resumed ownership read never attempts another create", async () => {
  for (const mine of [
    {},
    { communities: null },
    { communities: [null] },
    { communities: [{ id: "incomplete-entry" }] },
    { communities: [{ slug: "horizon", id: "owned-id" }] },
  ]) {
    let creates = 0;
    let checks = 0;
    let remembered = "horizon";
    const outcome = await provisionWorkspace(
      "Renamed company",
      remembered,
      {
        check: async () => {
          checks += 1;
          return { available: true };
        },
        create: async () => {
          creates += 1;
          return created("horizon");
        },
        listMine: async () => mine,
      },
      (slug) => {
        remembered = slug;
      },
    );
    assert.equal(outcome.reason, "unreachable");
    assert.equal(remembered, "horizon");
    assert.equal(checks, 0);
    assert.equal(creates, 0);
  }
});
