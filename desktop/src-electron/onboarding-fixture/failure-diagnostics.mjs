// Failure evidence only. Never repairs state, retries work, or changes transport.
import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { verifyEvent } from "nostr-tools/pure";

/** Bound and redact diagnostic text before it enters a public proof artifact. */
export const redactReason = (reason) =>
  Array.from(reason, (char) =>
    char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char,
  )
    .join("")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b(?:nsec1|npub1)[a-z0-9]+\b/gi, "[redacted-key]")
    .replace(/\b[a-f0-9]{64,}\b/gi, "[redacted-key]")
    .replace(
      /["']?\b(?:password|(?:access[_-]|refresh[_-])?token|(?:client[_-])?secret|api[_-]?key)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
      "[redacted-credential]",
    )
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted-credential]")
    .replace(/\s+/g, " ")
    .slice(0, 500);

function observeBoundedBody(stream, prefix, project, record) {
  let chunks = [];
  let size = 0;
  let finished = false;
  const finish = (value) => {
    if (finished) return;
    finished = true;
    chunks = [];
    // Failure evidence must never interrupt the original transport listener.
    try {
      record(value);
    } catch {
      // The owning evidence entry remains pending if its recorder is unavailable.
    }
  };
  stream.on("data", (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > 32 * 1024) finish({ unavailable: `${prefix}-limit` });
    else chunks.push(chunk);
  });
  stream.once("error", () => finish({ unavailable: `${prefix}-read` }));
  stream.once("aborted", () => finish({ unavailable: `${prefix}-aborted` }));
  stream.once("close", () =>
    finish({ unavailable: `${prefix}-closed-before-end` }),
  );
  stream.once("end", () => {
    if (finished) return;
    try {
      finish(project(Buffer.concat(chunks).toString("utf8")));
    } catch {
      finish({ unavailable: `${prefix}-parse` });
    }
  });
}

/** Observe public, signature-verified identity only; never retain request content or auth. */
export function observeEventRequest(request, record) {
  observeBoundedBody(
    request,
    "request",
    (raw) => {
      const body = JSON.parse(raw);
      if (!body || typeof body !== "object" || !verifyEvent(body))
        return { unavailable: "request-signature" };
      return { eventId: body.id, pubkey: body.pubkey, kind: body.kind };
    },
    record,
  );
}

/** Observe a bounded copy while the unmodified response keeps streaming to the app. */
export function observeEventResponse(response, record) {
  const httpStatus = response.statusCode ?? 200;
  observeBoundedBody(
    response,
    "response",
    (raw) => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        if (httpStatus === 200) return { unavailable: "response-parse" };
        return {
          httpStatus,
          messageFormat: "text-error",
          message: redactReason(raw),
        };
      }
      if (body?.accepted === true && httpStatus === 200)
        return { accepted: true };
      if (
        body?.accepted === false &&
        typeof body.event_id === "string" &&
        body.event_id.length === 64 &&
        /^[a-f0-9]{64}$/.test(body.event_id) &&
        typeof body.message === "string"
      ) {
        return {
          ...(httpStatus === 200 ? {} : { httpStatus }),
          accepted: false,
          eventId: body.event_id,
          message: redactReason(body.message),
        };
      }
      // The real bridge uses {error: string} before/around ingest. Only this
      // diagnostic string is retained, never arbitrary JSON or reflected fields.
      if (httpStatus !== 200 && typeof body?.error === "string")
        return {
          httpStatus,
          messageFormat: "json-error",
          message: redactReason(body.error),
        };
      return { unavailable: "response-shape" };
    },
    record,
  );
}

/** Project only bounded public ingest diagnostics, never arbitrary log fields. */
export function projectIngestFailures(lines, ownerPubkey) {
  assert.match(ownerPubkey, /^[a-f0-9]{64}$/);
  return lines
    .flatMap((line) => {
      let entry = null;
      try {
        entry = JSON.parse(line);
      } catch {
        return [];
      }
      if (!entry || typeof entry !== "object") return [];
      const fields = entry.fields ?? entry;
      if (
        fields.message !== "HTTP bridge request" ||
        fields.route !== "/events" ||
        fields.pubkey !== ownerPubkey ||
        fields.status !== 400 ||
        fields.accepted !== false ||
        ![30175, 30176, 30177, 40013].includes(fields.kind) ||
        typeof fields.reason !== "string"
      )
        return [];
      return [
        {
          kind: fields.kind,
          status: 400,
          reason: redactReason(fields.reason),
        },
      ];
    })
    .slice(-20);
}

/** Read the tail of the owned relay log before fixture cleanup removes it. */
export async function readIngestFailures(logPath, ownerPubkey) {
  const file = await open(logPath, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, size - length);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (size > length) lines.shift();
    return {
      logTailTruncated: size > length,
      // These lines identify ingest refusals for this owner/kind, not a
      // signed action correlation. Exact request authority is retained below.
      failures: projectIngestFailures(lines, ownerPubkey),
    };
  } finally {
    await file.close();
  }
}

/** Keep signed wire fields only; verification must precede diagnostic export. */
export function wireEvent(event) {
  return Object.fromEntries(
    ["id", "pubkey", "created_at", "kind", "tags", "content", "sig"].map(
      (key) => [key, event[key]],
    ),
  );
}
