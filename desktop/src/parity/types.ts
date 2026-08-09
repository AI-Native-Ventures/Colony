/**
 * Parity oracle trace types.
 *
 * A trace is a JSONL stream of records describing everything that crossed the
 * native bridge during one scripted session: every command (with args and
 * outcome), every emitted event, and every subscription push that arrived
 * through the Channel path. Relay pushes arrive as callbacks, not command
 * responses, so they get their own record kind — a command-only trace is
 * blind to the volume path.
 *
 * The trace is committed to git, so two properties are mandatory:
 * - binary payloads are recorded as `{length, sha256}`, never raw bytes
 *   (`push_audio_pcm` carries f32 samples every 20ms while transmitting);
 * - secrets are redacted at record time by the recorder's redactors.
 */

export const PARITY_TRACE_SCHEMA = "parity-trace/v1" as const;

/** Header line carrying session metadata. Every trace starts with one. */
export type TraceHeader = {
  schema: typeof PARITY_TRACE_SCHEMA;
  session: string;
  runId: string;
  recordedAt: string;
  relayUrl: string | null;
  appVersion: string | null;
  recordedBy: "tauri-internals" | "native-bridge";
};

export type CommandOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { message: string } };

export type CommandRecord = {
  kind: "command";
  seq: number;
  command: string;
  args: unknown;
  outcome: CommandOutcome;
  /** Wall-clock duration of the invoke, milliseconds. */
  durationMs: number;
};

export type EventRecord = {
  kind: "event";
  seq: number;
  name: string;
  payload: unknown;
};

export type PushRecord = {
  kind: "push";
  seq: number;
  /** Channel marker (`__CHANNEL__:<id>`) that carried this push. */
  subscription: string;
  payload: unknown;
};

export type TraceRecord = CommandRecord | EventRecord | PushRecord;

export type Trace = {
  header: TraceHeader;
  records: TraceRecord[];
};

/** Marker placed where a binary payload was replaced by its fingerprint. */
export type BinaryFingerprint = {
  $binary: {
    length: number;
    sha256: string;
  };
};

export const BINARY_MARKER = "$binary" as const;

/** Marker placed where a secret value was redacted at record time. */
export type RedactedValue = {
  $redacted: string;
};

export const REDACTED_MARKER = "$redacted" as const;

export function isBinaryFingerprint(
  value: unknown,
): value is BinaryFingerprint {
  return (
    typeof value === "object" &&
    value !== null &&
    BINARY_MARKER in value &&
    typeof (value as BinaryFingerprint)[BINARY_MARKER] === "object"
  );
}

export function isRedactedValue(value: unknown): value is RedactedValue {
  return (
    typeof value === "object" &&
    value !== null &&
    REDACTED_MARKER in value &&
    typeof (value as RedactedValue)[REDACTED_MARKER] === "string"
  );
}

export function encodeTrace(trace: Trace): string {
  const lines = [JSON.stringify(trace.header)];
  for (const record of trace.records) {
    lines.push(JSON.stringify(record));
  }
  return `${lines.join("\n")}\n`;
}

export function decodeTrace(text: string): Trace {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error("empty trace");
  }
  const header = JSON.parse(lines[0]) as TraceHeader;
  if (header.schema !== PARITY_TRACE_SCHEMA) {
    throw new Error(`unsupported trace schema: ${header.schema}`);
  }
  const records: TraceRecord[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parsed = JSON.parse(lines[i]) as TraceRecord;
    if (
      parsed.kind !== "command" &&
      parsed.kind !== "event" &&
      parsed.kind !== "push"
    ) {
      throw new Error(`unknown record kind on line ${i + 1}`);
    }
    records.push(parsed);
  }
  return { header, records };
}

/**
 * Deeply fingerprint binary values, leaving everything else untouched.
 * Async because the webview hashes via SubtleCrypto.
 */
export async function fingerprintBinary(value: unknown): Promise<unknown> {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return fingerprintBytesAsync(toBytes(value));
  }
  if (Array.isArray(value)) {
    // A dense array of small numbers is the serialized form of a binary
    // buffer (e.g. `push_audio_pcm` samples or `fetch_media_bytes` rows).
    // Anything dense and numeric is fingerprinted rather than recorded raw.
    if (isNumericArray(value)) {
      return fingerprintNumericArray(value);
    }
    const out = [];
    for (const item of value) {
      out.push(await fingerprintBinary(item));
    }
    return out;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = await fingerprintBinary(item);
    }
    return out;
  }
  return value;
}

function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  return new Uint8Array(value);
}

export function isNumericArray(value: unknown[]): boolean {
  // 32+ entries of small finite numbers: a byte buffer or PCM frame, not a
  // handful of counts in a business object. Only sample for the cost check.
  if (value.length < 32) {
    return false;
  }
  const sample = value.slice(0, 64);
  return sample.every(
    (item) =>
      typeof item === "number" && Number.isFinite(item) && Math.abs(item) < 1e9,
  );
}

function fingerprintNumericArray(values: number[]): Promise<BinaryFingerprint> {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i += 1) {
    view.setFloat32(i * 4, values[i], true);
  }
  return fingerprintBytesAsync(bytes);
}

async function fingerprintBytesAsync(
  bytes: Uint8Array,
): Promise<BinaryFingerprint> {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) {
    throw new Error("no crypto.subtle available for trace hashing");
  }
  const digest = await cryptoObj.subtle.digest(
    "SHA-256",
    bytes as BufferSource,
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { $binary: { length: bytes.length, sha256: hex } };
}
