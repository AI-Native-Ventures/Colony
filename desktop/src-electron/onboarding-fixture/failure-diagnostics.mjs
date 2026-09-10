// Failure evidence only. Never repairs state, retries work, or changes transport.
import assert from "node:assert/strict";
import { open } from "node:fs/promises";

const redactReason = (reason) =>
  Array.from(reason, (char) =>
    char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char,
  )
    .join("")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b(?:nsec1|npub1)[a-z0-9]+\b/gi, "[redacted-key]")
    .replace(/\b[a-f0-9]{64,}\b/gi, "[redacted-key]")
    .replace(
      /\b(?:Bearer\s+|(?:password|token|secret|api[_-]?key)\s*[:=]\s*)\S+/gi,
      "[redacted-credential]",
    )
    .replace(/\s+/g, " ")
    .slice(0, 500);

/** Observe a bounded copy while the unmodified response keeps streaming to the app. */
export function observeEventResponse(response, record) {
  let chunks = [];
  let size = 0;
  let finished = false;
  const finish = (value) => {
    if (finished) return;
    finished = true;
    chunks = [];
    record(value);
  };
  response.on("data", (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > 32 * 1024) finish({ unavailable: "response-limit" });
    else chunks.push(chunk);
  });
  response.once("error", () => finish({ unavailable: "response-read" }));
  response.once("aborted", () => finish({ unavailable: "response-aborted" }));
  response.once("close", () =>
    finish({ unavailable: "response-closed-before-end" }),
  );
  response.once("end", () => {
    if (finished) return;
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      finish({ unavailable: "response-parse" });
      return;
    }
    if (body?.accepted === true) finish({ accepted: true });
    else if (
      body?.accepted === false &&
      typeof body.event_id === "string" &&
      body.event_id.length === 64 &&
      /^[a-f0-9]{64}$/.test(body.event_id) &&
      typeof body.message === "string"
    ) {
      finish({
        accepted: false,
        eventId: body.event_id,
        message: redactReason(body.message),
      });
    } else finish({ unavailable: "response-shape" });
  });
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
