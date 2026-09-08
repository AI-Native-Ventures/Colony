import assert from "node:assert/strict";
import test from "node:test";
import { companyBlockedReason, companyReady } from "./CompanyScreen.tsx";
const business = {
  company: "Horizon Labs",
  website: "",
  description: "Branding and websites for small businesses.",
};
test("business needs a name and useful context, no revenue or website decision", () => {
  assert.equal(companyReady(business), true);
  assert.equal(companyReady({ ...business, company: " " }), false);
  assert.equal(companyReady({ ...business, description: " " }), false);
  assert.equal(
    companyReady({ ...business, stage: null, hasWebsite: null }),
    true,
  );
});
test("an optional website is validated when supplied", () => {
  assert.equal(companyReady({ ...business, website: "horizon.example" }), true);
  assert.equal(companyReady({ ...business, website: "invalid" }), false);
  assert.match(
    companyBlockedReason({ ...business, website: "invalid" }),
    /website address/,
  );
  assert.equal(companyBlockedReason(business), null);
});
