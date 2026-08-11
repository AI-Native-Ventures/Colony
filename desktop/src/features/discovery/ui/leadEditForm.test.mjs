import assert from "node:assert/strict";
import { test } from "node:test";

import { createFixtureDiscoveryDataSource } from "../data/FixtureDiscoveryDataSource.ts";
import {
  buildLeadUpdateInput,
  createLeadEditDraft,
  mergeFreshLeadValues,
  parseLeadScore,
} from "./leadEditForm.ts";

test("the draft seeds every editable field from the loaded lead", async () => {
  const source = createFixtureDiscoveryDataSource();
  const lead = await source.getLead("lead-001");
  const draft = createLeadEditDraft(lead);
  assert.equal(draft.website, "https://rosebankautocare.example");
  assert.equal(draft.email, "hello@rosebankautocare.example");
  assert.equal(draft.phone, "+27 11 555 0101");
  assert.equal(draft.contactName, "Mpho Dlamini");
  assert.equal(draft.contactTitle, "Owner");
  assert.equal(draft.score, "94");
  assert.equal(draft.owner, "");
  assert.equal(draft.notes, "");
  assert.equal(draft.linkedinUrl, "");
});

test("the submit input is the complete profile, with empty fields mapped to clear", async () => {
  const source = createFixtureDiscoveryDataSource();
  const lead = await source.getLead("lead-001");
  const draft = createLeadEditDraft(lead);
  const input = buildLeadUpdateInput(draft);
  assert.deepEqual(input, {
    website: "https://rosebankautocare.example",
    email: "hello@rosebankautocare.example",
    phone: "+27 11 555 0101",
    linkedinUrl: undefined,
    contactName: "Mpho Dlamini",
    contactTitle: "Owner",
    owner: undefined,
    score: 94,
    notes: undefined,
  });
  assert.equal("status" in input, false, "status belongs to ticket 4");
});

test("regression: editing only the website keeps owner, email and notes", async () => {
  const source = createFixtureDiscoveryDataSource();
  const lead = await source.getLead("lead-001");

  const seedDraft = createLeadEditDraft(lead);
  seedDraft.owner = "Chief of Staff";
  seedDraft.notes = "Warm intro, decision maker";
  const seeded = await source.updateLead(
    lead.id,
    buildLeadUpdateInput(seedDraft),
  );
  assert.equal(seeded.owner, "Chief of Staff");
  assert.equal(seeded.notes, "Warm intro, decision maker");

  const editDraft = createLeadEditDraft(seeded);
  editDraft.website = "https://rosebank.example";
  const input = buildLeadUpdateInput(editDraft);

  assert.equal(input.website, "https://rosebank.example");
  assert.equal(input.owner, "Chief of Staff", "owner must survive the edit");
  assert.equal(
    input.email,
    "hello@rosebankautocare.example",
    "email must survive",
  );
  assert.equal(input.notes, "Warm intro, decision maker", "notes must survive");

  const updated = await source.updateLead(lead.id, input);
  assert.equal(updated.website, "https://rosebank.example");
  assert.equal(updated.owner, "Chief of Staff");
  assert.equal(updated.email, "hello@rosebankautocare.example");
  assert.equal(updated.notes, "Warm intro, decision maker");
  assert.equal(updated.score, 94);
});

test("clearing a field submits an omission so the relay NULLs it", () => {
  const draft = {
    website: "",
    email: "keep@example.com",
    phone: "",
    linkedinUrl: "https://linkedin.example/in/keeper",
    contactName: "",
    contactTitle: "",
    owner: "",
    score: "",
    notes: "",
  };
  const input = buildLeadUpdateInput(draft);
  assert.equal(input.website, undefined);
  assert.equal(input.email, "keep@example.com");
  assert.equal(input.linkedinUrl, "https://linkedin.example/in/keeper");
  assert.equal(input.score, undefined);
});

test("stale re-fetch re-seeds untouched fields and keeps user edits", async () => {
  const source = createFixtureDiscoveryDataSource();
  const loaded = await source.getLead("lead-001");
  const draft = createLeadEditDraft(loaded);
  draft.website = "https://user-changed.example";
  draft.notes = "Written while the drawer was open";

  const fresh = {
    ...loaded,
    website: "https://other-member.example",
    email: "new-owner-email@example.com",
    owner: "Another persona",
    notes: "Someone else's note",
    score: 91,
  };
  const merged = mergeFreshLeadValues(draft, loaded, fresh);
  assert.equal(merged.website, "https://user-changed.example");
  assert.equal(merged.notes, "Written while the drawer was open");
  assert.equal(merged.email, "new-owner-email@example.com");
  assert.equal(merged.owner, "Another persona");
  assert.equal(merged.score, "91");
  assert.equal(merged.phone, loaded.phone);
});

test("score parsing matches the relay's integer contract", () => {
  assert.deepEqual(parseLeadScore(""), { ok: true, score: undefined });
  assert.deepEqual(parseLeadScore("94"), { ok: true, score: 94 });
  assert.deepEqual(parseLeadScore(" 80 "), { ok: true, score: 80 });
  assert.deepEqual(parseLeadScore("12.5"), { ok: false });
  assert.deepEqual(parseLeadScore("abc"), { ok: false });
});
