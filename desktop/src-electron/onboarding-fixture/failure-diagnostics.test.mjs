import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { finalizeEvent } from "nostr-tools/pure";
import {
  observeEventRequest,
  observeEventResponse,
} from "./failure-diagnostics.mjs";

async function capture(raw, observer, statusCode = 400) {
  const stream = new PassThrough();
  stream.statusCode = statusCode;
  const observations = [];
  const forwarded = [];
  observer(stream, (value) => observations.push(value));
  stream.on("data", (chunk) => forwarded.push(chunk));
  const ended = once(stream, "end");
  stream.write(raw.slice(0, 17));
  stream.end(raw.slice(17));
  await ended;
  assert.equal(Buffer.concat(forwarded).toString(), raw);
  assert.equal(observations.length, 1);
  return observations[0];
}

test("non-200 bridge errors retain bounded redacted reasons without changing streamed bytes", async () => {
  const reason =
    'invalid event JSON: token="private token with spaces" api_key=private-key password:secret-value https://secret.invalid/path?token=secret';
  const actual = await capture(
    JSON.stringify({
      error: reason,
      headers: { authorization: "never-export-this" },
      content: "never-export-this",
    }),
    observeEventResponse,
  );
  assert.equal(actual.httpStatus, 400);
  assert.equal(actual.messageFormat, "json-error");
  assert.match(actual.message, /^invalid event JSON: /);
  assert.doesNotMatch(JSON.stringify(actual), /private|secret|never-export/);
  assert.ok(actual.message.length <= 500);
  const text = await capture(
    `Failed to buffer body\nBearer private-token\t${"x".repeat(600)}`,
    observeEventResponse,
    413,
  );
  assert.equal(text.httpStatus, 413);
  assert.equal(text.messageFormat, "text-error");
  assert.match(text.message, /^Failed to buffer body \[redacted-credential\]/);
  assert.doesNotMatch(text.message, /private-token|\n|\t/);
  assert.equal(text.message.length, 500);
});

test("structured ingest refusal stays distinct from HTTP errors and unknown JSON is never exported", async () => {
  assert.deepEqual(
    await capture(
      JSON.stringify({
        accepted: false,
        event_id: "a".repeat(64),
        message: "refused",
      }),
      observeEventResponse,
    ),
    {
      httpStatus: 400,
      accepted: false,
      eventId: "a".repeat(64),
      message: "refused",
    },
  );
  for (const value of [null, [], { content: "private" }, { accepted: true }]) {
    assert.deepEqual(
      await capture(JSON.stringify(value), observeEventResponse),
      {
        unavailable: "response-shape",
      },
    );
  }
  assert.deepEqual(
    await capture("x".repeat(32 * 1024 + 1), observeEventResponse),
    {
      unavailable: "response-limit",
    },
  );
});

test("reflected OAuth credentials and Basic authorization are redacted", async () => {
  const message =
    'access_token=private-access refresh_token="private refresh" client_secret=private-secret Basic cHJpdmF0ZTpzZWNyZXQ=';
  for (const raw of [message, JSON.stringify({ error: message })]) {
    const result = await capture(raw, observeEventResponse);
    assert.equal(
      result.message,
      Array(4).fill("[redacted-credential]").join(" "),
    );
    assert.doesNotMatch(JSON.stringify(result), /private|cHJpdmF0ZTpzZWNyZXQ/);
  }
});

test("request correlation exports only the signature-verified public event identity", async () => {
  const key = new Uint8Array(32);
  key[31] = 1;
  const event = finalizeEvent(
    {
      kind: 9,
      created_at: 1,
      tags: [["private", "never-export-this"]],
      content: "never-export-this",
    },
    key,
  );
  assert.deepEqual(await capture(JSON.stringify(event), observeEventRequest), {
    eventId: event.id,
    pubkey: event.pubkey,
    kind: 9,
  });
  assert.deepEqual(
    await capture(
      JSON.stringify({ ...event, content: "tampered" }),
      observeEventRequest,
    ),
    {
      unavailable: "request-signature",
    },
  );
  assert.deepEqual(await capture("not JSON", observeEventRequest), {
    unavailable: "request-parse",
  });
  assert.deepEqual(
    await capture("x".repeat(32 * 1024 + 1), observeEventRequest),
    {
      unavailable: "request-limit",
    },
  );
});

test("read interruption and recorder failure leave the transport in control", async () => {
  for (const [observer, prefix] of [
    [observeEventRequest, "request"],
    [observeEventResponse, "response"],
  ]) {
    for (const [signal, suffix] of [
      ["aborted", "aborted"],
      ["error", "read"],
      ["close", "closed-before-end"],
    ]) {
      const stream = new PassThrough();
      const observations = [];
      observer(stream, (value) => observations.push(value));
      stream.emit(signal, new Error("private"));
      stream.emit("close");
      assert.deepEqual(observations, [{ unavailable: `${prefix}-${suffix}` }]);
      stream.destroy();
    }
    const stream = new PassThrough();
    const forwarded = [];
    observer(stream, () => {
      throw new Error("recorder unavailable");
    });
    stream.on("data", (chunk) => forwarded.push(chunk));
    const ended = once(stream, "end");
    stream.end("unchanged bytes");
    await ended;
    assert.equal(Buffer.concat(forwarded).toString(), "unchanged bytes");
  }
});
