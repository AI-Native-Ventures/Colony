import assert from "node:assert/strict";
import { test } from "node:test";

import {
  askRoutingSummary,
  classifyAskRouting,
  effectiveFilerPubkey,
} from "./askRouting.ts";

const AUDIENCE = "a".repeat(64);
const MANAGER = "b".repeat(64);
const ORIGINAL_FILER = "c".repeat(64);
const EVENT_FILER = "d".repeat(64);

test("a promoted ask is recognized by its prior tag, whatever it addresses", () => {
  const routing = classifyAskRouting(
    {
      audiencePubkey: MANAGER,
      priorAskId: AUDIENCE,
      originalFilerPubkey: null,
      filerPubkey: EVENT_FILER,
    },
    MANAGER,
  );
  assert.deepEqual(routing, {
    kind: "promoted",
    priorAskId: AUDIENCE,
  });
});

test("an ask addressed to the filer's resolved manager is auto-routed", () => {
  const routing = classifyAskRouting(
    {
      audiencePubkey: AUDIENCE,
      priorAskId: null,
      originalFilerPubkey: null,
      filerPubkey: EVENT_FILER,
    },
    AUDIENCE,
  );
  assert.deepEqual(routing, { kind: "auto", audiencePubkey: AUDIENCE });
});

test("auto-routing compares pubkeys case-insensitively", () => {
  const routing = classifyAskRouting(
    {
      audiencePubkey: AUDIENCE.toUpperCase(),
      priorAskId: null,
      originalFilerPubkey: null,
      filerPubkey: EVENT_FILER,
    },
    AUDIENCE,
  );
  assert.deepEqual(routing, { kind: "auto", audiencePubkey: AUDIENCE });
});

test("an ask addressed to someone other than the manager is an explicit choice", () => {
  const routing = classifyAskRouting(
    {
      audiencePubkey: AUDIENCE,
      priorAskId: null,
      originalFilerPubkey: null,
      filerPubkey: EVENT_FILER,
    },
    MANAGER,
  );
  assert.deepEqual(routing, { kind: "explicit", audiencePubkey: AUDIENCE });
});

test("an ask whose filer has no resolvable manager is an explicit choice", () => {
  const routing = classifyAskRouting(
    {
      audiencePubkey: AUDIENCE,
      priorAskId: null,
      originalFilerPubkey: null,
      filerPubkey: EVENT_FILER,
    },
    null,
  );
  assert.deepEqual(routing, { kind: "explicit", audiencePubkey: AUDIENCE });
});

test("an ask with no readable audience has no classification yet", () => {
  assert.equal(
    classifyAskRouting(
      {
        audiencePubkey: null,
        priorAskId: null,
        originalFilerPubkey: null,
        filerPubkey: EVENT_FILER,
      },
      MANAGER,
    ),
    null,
  );
});

test("the effective filer is the original filer across a promotion, not the relay", () => {
  assert.equal(effectiveFilerPubkey({ filerPubkey: EVENT_FILER }), EVENT_FILER);
  assert.equal(
    effectiveFilerPubkey({
      filerPubkey: EVENT_FILER,
      originalFilerPubkey: ORIGINAL_FILER,
    }),
    ORIGINAL_FILER,
  );
});

test("each routing kind summarizes in one short phrase", () => {
  assert.equal(askRoutingSummary(null), null);
  assert.equal(
    askRoutingSummary({ kind: "promoted", priorAskId: AUDIENCE }),
    "Promoted up the ladder",
  );
  assert.equal(
    askRoutingSummary({ kind: "auto", audiencePubkey: AUDIENCE }),
    "Auto-routed to the filer's manager",
  );
  assert.equal(
    askRoutingSummary({ kind: "explicit", audiencePubkey: AUDIENCE }),
    "Addressed directly",
  );
});
