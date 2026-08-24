import assert from "node:assert/strict";
import test from "node:test";

const { readAskResolution, describeAskResolution, pairResolutionsWithAsks } =
  await import("./askResolution.ts");

const ASK_HEX = "a".repeat(64);
const RELAY_HEX = "b".repeat(64);
const HUMAN_HEX = "c".repeat(64);

function resolutionEvent(id, pubkey, content, tags) {
  return {
    id,
    kind: 44301,
    pubkey,
    created_at: 1_000,
    content: JSON.stringify(content),
    tags: tags ?? [["e", ASK_HEX]],
  };
}

test("a relay-signed default execution reads default_executed and the applied option", () => {
  const resolution = readAskResolution(
    resolutionEvent("res-1", RELAY_HEX, {
      answer: { option: "Ship v2 to every customer" },
      default_executed: true,
    }),
  );
  assert.ok(resolution);
  assert.equal(resolution.askId, ASK_HEX);
  assert.equal(resolution.defaultExecuted, true);
  assert.equal(resolution.appliedOption, "Ship v2 to every customer");
  assert.equal(resolution.resolverPubkey, RELAY_HEX);
});

test("a human answer reads as not-default and keeps decision and rationale", () => {
  const resolution = readAskResolution(
    resolutionEvent("res-2", HUMAN_HEX, {
      answer: {
        decision: "Use the stable vendor",
        rationale: "fewer incidents",
      },
      default_executed: false,
    }),
  );
  assert.ok(resolution);
  assert.equal(resolution.defaultExecuted, false);
  assert.equal(resolution.appliedOption, null);
  assert.equal(resolution.decision, "Use the stable vendor");
  assert.equal(resolution.rationale, "fewer incidents");
});

test("default_executed is read strictly as true", () => {
  const truthyString = readAskResolution(
    resolutionEvent("res-3", RELAY_HEX, {
      answer: { option: "X" },
      default_executed: "true",
    }),
  );
  assert.ok(truthyString);
  assert.equal(
    truthyString.defaultExecuted,
    false,
    "only the boolean true counts, mirroring the relay's as_bool read",
  );
});

test("an executed default whose option is unreadable still reads as a default", () => {
  const resolution = readAskResolution(
    resolutionEvent("res-4", RELAY_HEX, { default_executed: true }),
  );
  assert.ok(resolution);
  assert.equal(resolution.defaultExecuted, true);
  assert.equal(resolution.appliedOption, null);
});

test("a human resolution with no answer text stays readable", () => {
  const resolution = readAskResolution(resolutionEvent("res-5", HUMAN_HEX, {}));
  assert.ok(resolution);
  assert.equal(resolution.defaultExecuted, false);
  assert.equal(resolution.decision, null);
});

test("a non-resolution kind reads as null", () => {
  assert.equal(
    readAskResolution({ ...resolutionEvent("m", HUMAN_HEX, {}), kind: 9 }),
    null,
  );
});

test("malformed content reads as null rather than throwing", () => {
  assert.equal(
    readAskResolution({
      ...resolutionEvent("bad", HUMAN_HEX, {}),
      content: "{not json",
    }),
    null,
  );
});

test("a missing e tag reads as null", () => {
  assert.equal(
    readAskResolution(resolutionEvent("no-e", HUMAN_HEX, {}, [])),
    null,
  );
});

test("duplicate e tags read as null, fail closed like the relay's single_tag_value", () => {
  assert.equal(
    readAskResolution(
      resolutionEvent("two-e", HUMAN_HEX, {}, [
        ["e", ASK_HEX],
        ["e", "d".repeat(64)],
      ]),
    ),
    null,
  );
});

test("a non-hex64 e tag reads as null, mirroring the relay's hex64 validation", () => {
  assert.equal(
    readAskResolution(
      resolutionEvent("short-e", HUMAN_HEX, {}, [["e", "abc"]]),
    ),
    null,
  );
});

test("default-execution copy names the option and says plainly that nobody answered", () => {
  const resolution = readAskResolution(
    resolutionEvent("res-copy-1", RELAY_HEX, {
      answer: { option: "Refund the customer" },
      default_executed: true,
    }),
  );
  const copy = describeAskResolution(resolution, null);
  assert.ok(copy.includes("Nobody answered"), copy);
  assert.ok(copy.includes("deadline"), copy);
  assert.ok(copy.includes("Refund the customer"), copy);
  assert.ok(
    !copy.toLowerCase().includes("decision"),
    "defaults fire for ANY owner-addressed ask, so the copy must not call it a decision",
  );
});

test("default-execution copy without a readable option still accounts for what happened", () => {
  const resolution = readAskResolution(
    resolutionEvent("res-copy-2", RELAY_HEX, { default_executed: true }),
  );
  const copy = describeAskResolution(resolution, null);
  assert.ok(copy.includes("Nobody answered"), copy);
  assert.ok(copy.includes("deadline"), copy);
  assert.ok(copy.toLowerCase().includes("default"), copy);
});

test("human-answer copy names who answered and what they decided", () => {
  const resolution = readAskResolution(
    resolutionEvent("res-copy-3", HUMAN_HEX, {
      answer: { decision: "Use the stable vendor" },
    }),
  );
  const copy = describeAskResolution(resolution, "Basheer");
  assert.ok(copy.includes("Basheer"), copy);
  assert.ok(copy.includes("Use the stable vendor"), copy);
});

test("human-answer copy falls back to a neutral name when no label resolved", () => {
  const resolution = readAskResolution(
    resolutionEvent("res-copy-4", HUMAN_HEX, {
      answer: { decision: "Approved" },
    }),
  );
  const copy = describeAskResolution(resolution, null);
  assert.ok(copy.includes("Approved"), copy);
  assert.ok(copy.trim().length > 0);
});

test("resolutions pair with their asks and drop unpaired ones, newest first", () => {
  const olderAsk = {
    id: ASK_HEX,
    askType: "decision",
    headline: "Older headline",
    costOfDelay: null,
    filerPubkey: HUMAN_HEX,
    createdAt: 900,
    rawContent: "{}",
    channelId: null,
    threadId: null,
    audiencePubkey: null,
    priorAskId: null,
    originalFilerPubkey: null,
  };
  const newerAsk = {
    ...olderAsk,
    id: "d".repeat(64),
    headline: "Newer headline",
  };
  const humanAt = readAskResolution(
    resolutionEvent("old-res", HUMAN_HEX, { answer: { decision: "A" } }),
  );
  const defaultAt = readAskResolution({
    ...resolutionEvent("new-res", RELAY_HEX, {
      answer: { option: "B" },
      default_executed: true,
    }),
    created_at: 2_000,
    tags: [["e", "d".repeat(64)]],
  });
  const paired = pairResolutionsWithAsks(
    [defaultAt, humanAt],
    [olderAsk, newerAsk],
  );
  assert.deepEqual(
    paired.map((entry) => entry.resolution.eventId),
    ["new-res", "old-res"],
  );
  assert.equal(paired[1].ask.headline, "Older headline");
  assert.equal(paired[0].ask.headline, "Newer headline");
});

test("pairing keeps only the newest resolution per ask", () => {
  const ask = {
    id: ASK_HEX,
    askType: "question",
    headline: "H",
    costOfDelay: null,
    filerPubkey: HUMAN_HEX,
    createdAt: 900,
    rawContent: "{}",
    channelId: null,
    threadId: null,
    audiencePubkey: null,
    priorAskId: null,
    originalFilerPubkey: null,
  };
  const superseded = readAskResolution({
    ...resolutionEvent("res-old", HUMAN_HEX, { answer: { decision: "stale" } }),
    created_at: 100,
  });
  const winner = readAskResolution({
    ...resolutionEvent("res-new", HUMAN_HEX, {
      answer: { decision: "current" },
    }),
    created_at: 200,
  });
  const paired = pairResolutionsWithAsks([superseded, winner], [ask]);
  assert.equal(paired.length, 1);
  assert.equal(paired[0].resolution.decision, "current");
});
