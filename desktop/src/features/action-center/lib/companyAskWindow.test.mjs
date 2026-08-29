import assert from "node:assert/strict";
import test from "node:test";

import { readCompanyAskWindowSecs } from "./companyAskWindow.ts";

const RELAY = "a".repeat(64);

function companyProfileEvent(content, overrides = {}) {
  return {
    id: "event-1",
    pubkey: RELAY,
    created_at: 100,
    kind: 30179,
    tags: [],
    content: JSON.stringify(content),
    sig: "",
    ...overrides,
  };
}

test("reads ask_window_secs off the relay-authored company profile head", () => {
  const value = readCompanyAskWindowSecs(
    [companyProfileEvent({ ask_window_secs: 7_200 })],
    RELAY,
  );
  assert.equal(value, 7_200);
});

test("is tolerant of a head that also carries unrelated business-profile fields", () => {
  // The relay's own read never validates against the business-profile
  // schema (`CompanyProfile`/`matchesShape`) — it just reads one field off
  // whatever JSON the head carries. This reader must do the same, unlike
  // `parseCompanyHead`, which would reject the whole event outright for
  // carrying an unexpected extra key.
  const value = readCompanyAskWindowSecs(
    [
      companyProfileEvent({
        schema: "colony.company/v1",
        tradingName: "Acme",
        ask_window_secs: 5_400,
      }),
    ],
    RELAY,
  );
  assert.equal(value, 5_400);
});

test("returns null when there is no company profile event yet", () => {
  assert.equal(readCompanyAskWindowSecs([], RELAY), null);
});

test("returns null when the relay pubkey has not resolved yet", () => {
  assert.equal(
    readCompanyAskWindowSecs(
      [companyProfileEvent({ ask_window_secs: 1 })],
      null,
    ),
    null,
  );
});

test("returns null when ask_window_secs is absent or the wrong type", () => {
  assert.equal(
    readCompanyAskWindowSecs([companyProfileEvent({})], RELAY),
    null,
  );
  assert.equal(
    readCompanyAskWindowSecs(
      [companyProfileEvent({ ask_window_secs: "7200" })],
      RELAY,
    ),
    null,
  );
  assert.equal(
    readCompanyAskWindowSecs(
      [companyProfileEvent({ ask_window_secs: -1 })],
      RELAY,
    ),
    null,
  );
});

test("ignores a profile-shaped event authored by someone other than the relay", () => {
  const value = readCompanyAskWindowSecs(
    [
      companyProfileEvent(
        { ask_window_secs: 7_200 },
        { pubkey: "b".repeat(64) },
      ),
    ],
    RELAY,
  );
  assert.equal(value, null);
});
