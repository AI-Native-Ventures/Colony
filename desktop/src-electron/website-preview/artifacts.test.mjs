import assert from "node:assert/strict";
import { test } from "node:test";

import { createAuthorizedDependencies, sha256Hex } from "./artifact.mjs";
import { loadVerifiedArtifact } from "./artifacts.mjs";

const RELAY_ORIGIN = "https://relay.example.com";
const MEDIA_HASH =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const QA_URL = `${RELAY_ORIGIN}/media/${MEDIA_HASH}.json`;

test("loads an independent QA artifact through the authorized Blossom reader", async () => {
  const body = Buffer.from(
    JSON.stringify({
      schema: "colony.website-qa/1",
      result: "pass",
      revision: 2,
      checks: ["desktop", "mobile"],
    }),
  );
  const world = {
    async lookup() {
      return [{ address: "93.184.216.34", family: 4 }];
    },
    async open() {
      throw new Error("private QA must not use the public transport");
    },
  };
  const calls = [];
  const dependencies = createAuthorizedDependencies({
    relayOrigin: RELAY_ORIGIN,
    dependencies: world,
    fetchMediaBytes: async (url) => {
      calls.push(url);
      return { bytes: body, contentType: "application/json" };
    },
  });

  const result = await loadVerifiedArtifact({
    ref: { url: QA_URL, sha256: sha256Hex(body) },
    dependencies,
  });

  assert.deepEqual(result.bytes, body);
  assert.equal(result.contentType, "application/json");
  assert.deepEqual(calls, [QA_URL]);
});

test("a foreign artifact URL remains outside the authorized reader", async () => {
  const body = Buffer.from("foreign artifact");
  let authorizedCalls = 0;
  const dependencies = createAuthorizedDependencies({
    relayOrigin: RELAY_ORIGIN,
    dependencies: {
      async lookup() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
      async open() {
        return {
          statusCode: 200,
          headers: {},
          destroy() {},
          body: (async function* () {
            yield body;
          })(),
        };
      },
    },
    fetchMediaBytes: async () => {
      authorizedCalls += 1;
      return body;
    },
  });

  const result = await loadVerifiedArtifact({
    ref: {
      url: "https://cdn.example.com/qa/report.json",
      sha256: sha256Hex(body),
    },
    dependencies,
  });
  assert.deepEqual(result.bytes, body);
  assert.equal(authorizedCalls, 0);
});
