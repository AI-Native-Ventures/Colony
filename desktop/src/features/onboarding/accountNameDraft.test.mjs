import assert from "node:assert/strict";
import test from "node:test";

import {
  clearAccountNameDraft,
  founderWithName,
  readAccountNameDraft,
  saveAccountNameDraft,
} from "./accountNameDraft.ts";

function store() {
  const values = new Map();
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    remove: (key) => values.delete(key),
  };
}

test("signup name survives remount and only restores for the registered email", () => {
  const storage = store();
  saveAccountNameDraft(storage, " OWNER@EXAMPLE.COM ", " Aisha Bello ");
  assert.equal(
    readAccountNameDraft(storage, "owner@example.com"),
    "Aisha Bello",
  );
  assert.equal(readAccountNameDraft(storage, "other@example.com"), "");
  clearAccountNameDraft(storage, "other@example.com");
  assert.equal(
    readAccountNameDraft(storage, "owner@example.com"),
    "Aisha Bello",
  );
  clearAccountNameDraft(storage, "owner@example.com");
  assert.equal(readAccountNameDraft(storage, "owner@example.com"), "");
});

test("only one bounded name draft is kept and it contains no signup secrets", () => {
  const storage = store();
  saveAccountNameDraft(storage, "first@example.com", "First");
  saveAccountNameDraft(storage, "second@example.com", "Second");
  assert.equal(storage.values.size, 1);
  assert.deepEqual(JSON.parse([...storage.values.values()][0]), {
    email: "second@example.com",
    fullName: "Second",
  });
  assert.equal(readAccountNameDraft(storage, "first@example.com"), "");
});

test("a storage failure stops signup before its public name can be lost", () => {
  assert.throws(
    () =>
      saveAccountNameDraft({ ...store(), set: () => false }, "a@b.co", "Aisha"),
    /Could not save your name/,
  );
});

test("name handoff preserves existing founder details and never invents a name", () => {
  const founder = {
    fullName: "Aisha",
    city: "Cape Town",
    country: "South Africa",
    gender: null,
    selfDescribedGender: "",
    avatarUrl: "https://example.com/aisha.png",
  };
  assert.deepEqual(founderWithName(founder, " Aisha Bello "), {
    ...founder,
    fullName: "Aisha Bello",
  });
  assert.equal(founderWithName(founder, ""), founder);
  assert.equal(founderWithName(null, ""), null);
  assert.equal(founderWithName(null, "npub1unknown"), null);
  assert.equal(founderWithName(null, "Owner").fullName, "Owner");
});
