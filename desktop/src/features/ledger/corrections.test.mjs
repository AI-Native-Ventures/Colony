import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMERCIAL_PURPOSE_LABELS,
  COMMERCIAL_PURPOSE_OPTIONS,
  correctionProblem,
} from "./corrections.ts";

function request(overrides = {}) {
  return {
    usageRecordEventId: "a".repeat(64),
    companyId: "horizon-labs",
    costCentreId: "web-delivery",
    owningTeamId: "web-team",
    commercialPurpose: "internalProduct",
    clientOrganizationId: null,
    taskId: null,
    reason: "was billable client work",
    ...overrides,
  };
}

test("a complete correction has no problem", () => {
  assert.equal(correctionProblem(request()), null);
});

test("a correction without a reason is refused", () => {
  // An unexplained restatement is not an audit trail.
  assert.match(correctionProblem(request({ reason: "   " })), /Give a reason/);
});

test("client delivery must name the client it was delivered to", () => {
  // Without it the spend is marked billable but attached to no one, which is
  // worse than leaving it unattributed: it looks resolved.
  assert.match(
    correctionProblem(request({ commercialPurpose: "clientDelivery" })),
    /needs the client/,
  );
  assert.equal(
    correctionProblem(
      request({
        clientOrganizationId: "tennant-group",
        commercialPurpose: "clientDelivery",
      }),
    ),
    null,
  );
});

test("a non-delivery purpose does not require a client", () => {
  assert.equal(
    correctionProblem(request({ commercialPurpose: "sales" })),
    null,
  );
});

test("the record must be named by a real event id", () => {
  for (const id of ["", "not-an-event", "a".repeat(63), `${"a".repeat(63)}z`]) {
    assert.match(
      correctionProblem(request({ usageRecordEventId: id })),
      /cannot be identified/,
      `${id} must be refused`,
    );
  }
});

test("company, cost centre and team are each required", () => {
  assert.match(correctionProblem(request({ companyId: " " })), /company/);
  assert.match(
    correctionProblem(request({ costCentreId: " " })),
    /cost centre/,
  );
  assert.match(correctionProblem(request({ owningTeamId: " " })), /team/);
});

test("every commercial purpose offered has a human label", () => {
  // A purpose with no label would render as its raw enum name.
  for (const purpose of COMMERCIAL_PURPOSE_OPTIONS) {
    assert.equal(
      typeof COMMERCIAL_PURPOSE_LABELS[purpose],
      "string",
      `${purpose} needs a label`,
    );
    assert.ok(COMMERCIAL_PURPOSE_LABELS[purpose].length > 0);
  }
  assert.equal(
    Object.keys(COMMERCIAL_PURPOSE_LABELS).length,
    COMMERCIAL_PURPOSE_OPTIONS.length,
    "labels and options must stay in step",
  );
});
