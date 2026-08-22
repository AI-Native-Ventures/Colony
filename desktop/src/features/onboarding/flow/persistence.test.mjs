import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_ANSWERS,
  clearAnswers,
  loadAnswers,
  saveAnswers,
} from "./persistence.ts";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
    _map: map,
  };
}

test("persistence_round_trips_answers", () => {
  const storage = fakeStorage();
  saveAnswers(storage, { ...EMPTY_ANSWERS, company: "Rosebank Auto Care" });
  assert.equal(loadAnswers(storage).company, "Rosebank Auto Care");
});

test("persistence_returns_empty_answers_when_nothing_is_stored", () => {
  assert.deepEqual(loadAnswers(fakeStorage()), EMPTY_ANSWERS);
});

test("persistence_survives_corrupt_json_rather_than_throwing", () => {
  // A half-written value must not brick first run for that profile.
  const storage = fakeStorage({ "colony.onboarding.answers": "{not json" });
  assert.deepEqual(loadAnswers(storage), EMPTY_ANSWERS);
});

test("persistence_ignores_unknown_keys_from_an_older_build", () => {
  const storage = fakeStorage({
    "colony.onboarding.answers": JSON.stringify({
      company: "Rosebank Auto Care",
      dinosaur: true,
    }),
  });
  const loaded = loadAnswers(storage);
  assert.equal(loaded.company, "Rosebank Auto Care");
  assert.equal("dinosaur" in loaded, false);
});

test("clear_removes_the_stored_answers", () => {
  const storage = fakeStorage();
  saveAnswers(storage, { ...EMPTY_ANSWERS, company: "X" });
  clearAnswers(storage);
  assert.deepEqual(loadAnswers(storage), EMPTY_ANSWERS);
});
