// desktop/src/features/onboarding/flow/stashFounderBrief.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { stashFounderBrief } from "./stashFounderBrief.ts";
import { EMPTY_ANSWERS } from "./persistence.ts";
import {
  loadCommunityOnboardingTransaction,
  startCommunityOnboarding,
} from "../communityOnboarding.tsx";

function storageStub(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const ANSWERS = {
  ...EMPTY_ANSWERS,
  company: "Rosebank Auto Care",
  founder: {
    fullName: "Aisha Bello",
    city: "Johannesburg",
    country: "South Africa",
    gender: "woman",
    selfDescribedGender: "",
  },
};

test("the answers land on the transaction the brief is sent from", () => {
  const storage = storageStub();
  startCommunityOnboarding(
    { relayUrl: "wss://relay.example", source: "join-community" },
    storage,
  );
  stashFounderBrief(ANSWERS, storage);
  const saved = loadCommunityOnboardingTransaction(storage);
  assert.equal(saved?.onboardingV2?.founder.fullName, "Aisha Bello");
  assert.equal(saved?.onboardingV2?.founder.country, "South Africa");
  assert.equal(saved?.onboardingV2?.founder.gender, "woman");
});

test("no transaction is not an error", () => {
  // The community can predate this flow; onboarding still finishes.
  const storage = storageStub();
  assert.doesNotThrow(() => stashFounderBrief(ANSWERS, storage));
  assert.equal(loadCommunityOnboardingTransaction(storage), null);
});

test("a storage that throws never blocks finishing", () => {
  const hostile = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {},
  };
  assert.doesNotThrow(() => stashFounderBrief(ANSWERS, hostile));
});
