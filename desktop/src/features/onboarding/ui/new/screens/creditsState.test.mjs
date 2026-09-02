import assert from "node:assert/strict";
import test from "node:test";

import {
  checkoutNote,
  defaultPack,
  formatGrant,
  formatPrice,
  priceOf,
} from "./CreditsScreen.tsx";

const STARTER = {
  id: "starter",
  name: "Starter",
  zarCents: 11_900,
  usdCents: 699,
  grantNanousd: 5_000_000_000,
};

/** A well-formed pack carrying only what defaultPack reads: the id. */
function pack(id) {
  return { ...STARTER, id, name: id };
}

const LADDER_THREE = ["starter", "growth", "scale"].map(pack);
const LADDER_SEVEN = [
  "starter",
  "growth",
  "scale",
  "pro",
  "studio",
  "agency",
  "enterprise",
].map(pack);

test("credits_default_selection_is_growth_whatever_the_catalogue_size", () => {
  // The default is pinned by id, not position. A positional default drifts
  // every time the catalogue changes: the middle of three packs is "growth",
  // the middle of seven is "pro" at ten times the price, and a first-time
  // buyer would land on R2449 preselected. Adding tiers must never move
  // what a new buyer is defaulted into.
  assert.equal(defaultPack(LADDER_SEVEN)?.id, "growth");
  assert.equal(defaultPack(LADDER_THREE)?.id, "growth");

  // A future tier inserted anywhere in the ladder must not move it either.
  const eight = [...LADDER_SEVEN];
  eight.splice(3, 0, pack("mega"));
  assert.equal(defaultPack(eight)?.id, "growth");
});

test("credits_default_falls_back_to_the_cheapest_pack_not_an_expensive_one", () => {
  // If the relay ever stops selling "growth", the fallback errs toward the
  // smallest charge: the list is ordered cheapest-first, so the head of the
  // list is the safe direction. Never the middle, never the tail.
  const withoutGrowth = ["starter", "scale", "pro", "enterprise"].map(pack);
  assert.equal(defaultPack(withoutGrowth)?.id, "starter");
  assert.equal(defaultPack([]), null);
});

test("credits_price_carries_the_symbol_of_the_charge_currency", () => {
  // The charge is Rands on PayFast and dollars on Paystack. Labelling a
  // R119.00 charge with a dollar sign would tell the buyer they are about to
  // pay roughly eighteen times what they are.
  assert.equal(formatPrice(11_900, "ZAR"), "R119");
  assert.equal(formatPrice(699, "USD"), "$6.99");
  assert.equal(formatPrice(29_900, "ZAR"), "R299");
  assert.equal(formatPrice(1_799, "USD"), "$17.99");
});

test("credits_price_keeps_cents_only_when_there_are_any", () => {
  assert.equal(formatPrice(500, "USD"), "$5");
  assert.equal(formatPrice(505, "USD"), "$5.05");
  assert.equal(formatPrice(550, "USD"), "$5.50");
  assert.equal(formatPrice(0, "ZAR"), "R0");
});

test("credits_grant_is_shown_in_dollars_whatever_the_charge", () => {
  // Credits are dollar-denominated because Colony's own costs are: model
  // providers bill dollars. So the grant reads the same to every buyer,
  // however they paid.
  assert.equal(formatGrant(5_000_000_000), "$5");
  assert.equal(formatGrant(14_000_000_000), "$14");
  assert.equal(formatGrant(44_000_000_000), "$44");
});

test("credits_pack_price_is_selected_never_converted", () => {
  // Each currency's price is read straight off the pack. If these two ever
  // agree, or one is derived from the other, a conversion has crept back in.
  assert.equal(priceOf(STARTER, "ZAR"), 11_900);
  assert.equal(priceOf(STARTER, "USD"), 699);
  assert.notEqual(priceOf(STARTER, "ZAR"), priceOf(STARTER, "USD"));
});

test("credits_note_promises_a_website_refund_only_when_one_was_read", () => {
  // The sentence was shown on every onboarding run, including the ones where
  // the founder answered "no website" and nothing was ever read. Promising
  // money back against a charge that never happened is a claim the screen
  // cannot keep.
  assert.equal(
    checkoutNote("USD", "idle", false, false),
    "",
    "no website read, dollars: nothing to say",
  );
  assert.match(
    checkoutNote("USD", "idle", false, true),
    /reading your website comes off this first payment/,
  );
  assert.doesNotMatch(
    checkoutNote("ZAR", "idle", false, false),
    /website/,
    "the rand explanation must not drag the website promise in with it",
  );
  assert.match(
    checkoutNote("ZAR", "idle", false, true),
    /reading your website comes off this first payment/,
  );
});

test("credits_note_says_what_happened_before_it_says_anything_else", () => {
  // A failed or unconfirmed checkout is the only thing worth reading at that
  // moment, so it replaces the note rather than joining it.
  assert.match(
    checkoutNote("ZAR", "abandoned", false, true),
    /^That payment was not completed\./,
  );
  assert.match(
    checkoutNote("ZAR", "idle", true, true),
    /^We could not reach Colony to confirm that payment\./,
  );
});
