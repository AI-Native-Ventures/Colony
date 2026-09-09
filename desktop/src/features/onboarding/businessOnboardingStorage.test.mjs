import assert from "node:assert/strict";
import test from "node:test";
import {
  startCommunityOnboarding,
  clearCommunityOnboardingTransaction,
  updateCommunityOnboardingTransaction,
  markCommunityOnboardingComplete,
  isCurrentCommunityOnboardingTransaction,
} from "./communityOnboarding.tsx";
import {
  businessOnboardingKey,
  loadPendingBusinessOnboarding,
  removePendingBusinessOnboarding,
  transactionBelongsToOwner,
} from "./businessOnboardingStorage.ts";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
const owner = "a".repeat(64);
const other = "b".repeat(64);
const one = "wss://one.example";
const two = "wss://two.example";
const input = (ownerPubkey, relayUrl) => ({
  source: "create-community",
  ownerPubkey,
  relayUrl,
});

test("suspending the active connection preserves the same business draft and delivery marker", () => {
  const db = storage();
  const run = startCommunityOnboarding(input(owner, one), db);
  updateCommunityOnboardingTransaction(
    run,
    { stage: "profile", communityName: "Saved business" },
    db,
  );
  clearCommunityOnboardingTransaction(db);
  const resumed = startCommunityOnboarding(input(owner, one), db);
  assert.equal(resumed.id, run.id);
  assert.equal(resumed.communityName, "Saved business");
  assert.equal(
    resumed.onboardingV2.firstTask.deliveryMarker,
    run.onboardingV2.firstTask.deliveryMarker,
  );
});

test("owners and businesses have separate progress; completing one cannot erase another", () => {
  const db = storage();
  const a = startCommunityOnboarding(input(owner, one), db);
  const b = startCommunityOnboarding(input(owner, two), db);
  const c = startCommunityOnboarding(input(other, one), db);
  markCommunityOnboardingComplete(owner, one, db);
  removePendingBusinessOnboarding(a, db);
  assert.equal(loadPendingBusinessOnboarding(owner, one, db), null);
  assert.equal(loadPendingBusinessOnboarding(owner, two, db).id, b.id);
  assert.equal(loadPendingBusinessOnboarding(other, one, db).id, c.id);
  assert.equal(
    db.getItem(
      `buzz-community-onboarding-complete.v1:${encodeURIComponent(two)}:${owner}`,
    ),
    null,
  );
});

test("a late completion cannot remove a replacement transaction", () => {
  const db = storage();
  const original = startCommunityOnboarding(input(owner, one), db);
  const replacement = { ...original, id: "replacement" };
  updateCommunityOnboardingTransaction(replacement, { stage: "profile" }, db);
  assert.equal(
    isCurrentCommunityOnboardingTransaction(original.id, owner, one, db),
    false,
  );
  assert.equal(
    isCurrentCommunityOnboardingTransaction(replacement.id, owner, one, db),
    true,
  );
  assert.equal(
    isCurrentCommunityOnboardingTransaction(replacement.id, other, one, db),
    false,
  );
  assert.equal(
    isCurrentCommunityOnboardingTransaction(replacement.id, owner, two, db),
    false,
  );
  removePendingBusinessOnboarding(original, db);
  assert.equal(
    loadPendingBusinessOnboarding(owner, one, db).id,
    replacement.id,
  );
});

test("restoration rejects another owner and unbound legacy creation, without changing joins", () => {
  const run = startCommunityOnboarding(input(owner, one), storage());
  assert.equal(transactionBelongsToOwner(run, owner), true);
  assert.equal(transactionBelongsToOwner(run, other), false);
  assert.equal(
    transactionBelongsToOwner({ ...run, ownerPubkey: undefined }, owner),
    false,
  );
  assert.equal(
    transactionBelongsToOwner(
      { ...run, ownerPubkey: undefined, source: "add-community" },
      owner,
    ),
    true,
  );
});

test("malformed or foreign stored progress cannot silently become a new setup", () => {
  const db = storage();
  const key = businessOnboardingKey(owner, one);
  db.setItem(key, "not json");
  assert.throws(() => startCommunityOnboarding(input(owner, one), db));
  db.setItem(
    key,
    JSON.stringify({
      source: "create-community",
      ownerPubkey: other,
      relayUrl: one,
      id: "foreign",
    }),
  );
  assert.throws(() => loadPendingBusinessOnboarding(owner, one, db));
  assert.equal(businessOnboardingKey(owner, "wss://ONE.example/"), key);
});

test("an existing business run cannot be redirected by changing its relay", () => {
  const db = storage();
  const run = startCommunityOnboarding(input(owner, one), db);
  assert.throws(
    () => updateCommunityOnboardingTransaction(run, { relayUrl: two }, db),
    /belongs/,
  );
  assert.equal(loadPendingBusinessOnboarding(owner, one, db).id, run.id);
  assert.equal(loadPendingBusinessOnboarding(owner, two, db), null);
});

test("scoped restoration migrates legacy drafts and retains unreadable drafts for recovery", () => {
  const db = storage();
  const run = startCommunityOnboarding(input(owner, one), db);
  const key = businessOnboardingKey(owner, one);
  db.setItem(
    key,
    JSON.stringify({
      ...run,
      onboardingV2: {
        version: 1,
        stage: "description",
        company: { summary: "Existing context." },
        firstTask: {
          content: "",
          deliveryMarker: "saved-marker",
          deliveredEventId: null,
        },
      },
    }),
  );
  const recovered = loadPendingBusinessOnboarding(owner, one, db);
  assert.equal(recovered.onboardingV2.version, 2);
  assert.equal(recovered.onboardingV2.company.summary, "Existing context.");
  assert.equal(recovered.onboardingV2.firstTask.deliveryMarker, "saved-marker");
  const broken = JSON.stringify({ ...run, onboardingV2: "invalid draft" });
  db.setItem(key, broken);
  assert.throws(
    () => loadPendingBusinessOnboarding(owner, one, db),
    /could not be recovered/,
  );
  assert.equal(db.getItem(key), broken);
});
