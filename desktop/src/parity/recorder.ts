/**
 * Parity trace recorder.
 *
 * Sits at the native bridge seam (today: wrapped around
 * `window.__TAURI_INTERNALS__`; after the seam lands: `wrapNativeBridge`).
 * Records every command, every emitted event, and every subscription push.
 *
 * The recorder is a singleton, disabled by default. When disabled it is a
 * no-op object — callers pay one boolean check, nothing is buffered, and the
 * module is only loaded behind the compile-time `VITE_PARITY_RECORD` flag.
 */

import {
  BINARY_MARKER,
  REDACTED_MARKER,
  type BinaryFingerprint,
  type CommandOutcome,
  type EventRecord,
  type PushRecord,
  type Trace,
  type TraceHeader,
  type TraceRecord,
  fingerprintBinary,
} from "@/parity/types";

export type Redactor = (value: unknown) => unknown;

/** Record-time redaction rules, keyed by command name. */
export type RedactorTable = Record<
  string,
  { args?: Redactor; result?: Redactor }
>;

const SENSITIVE_KEY =
  /(api_?key|secret|token|nsec|private_?key|password|authorization|credential)/i;

/** Deep-redact any value under a sensitive-looking key. */
export function redactSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveKeys(item));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = { [REDACTED_MARKER]: key };
      } else {
        out[key] = redactSensitiveKeys(item);
      }
    }
    return out;
  }
  return value;
}

function redactAll(reason: string): Redactor {
  return () => ({ [REDACTED_MARKER]: reason });
}

/**
 * Record-time redaction rules, applied to command RESULTS only. Anything
 * matching SENSITIVE_KEY is redacted by default; commands whose whole result
 * is sensitive (an nsec, a pairing QR containing the nsec, stored
 * credentials) get a whole-value redactor here.
 *
 * ARGS ARE NEVER REDACTED: the replay harness re-invokes every recorded
 * command with the recorded args, so a redaction marker in an arg would be
 * passed to the native layer as if it were a real value. The scripted
 * session is fixture-only — nothing secret is ever in an arg — and
 * result-side redaction keeps the committed trace free of secrets.
 */
export const DEFAULT_REDACTORS: RedactorTable = {
  get_nsec: { result: redactAll("nsec") },
  start_pairing: { result: redactAll("pairing QR contains nsec") },
  get_runtime_file_config: {
    result: redactAll("runtime config may hold keys"),
  },
  get_global_agent_config: {
    result: redactAll("global agent config may hold keys"),
  },
};

export type ParityRecorderOptions = {
  redactors?: RedactorTable;
  /** Optional external sink for completed traces (the in-app driver). */
  onTrace?: (trace: Trace) => void;
};

export class ParityRecorder {
  private readonly records: TraceRecord[] = [];
  private seq = 0;
  private readonly redactors: RedactorTable;
  private readonly onTrace?: (trace: Trace) => void;

  constructor(options: ParityRecorderOptions = {}) {
    this.redactors = { ...DEFAULT_REDACTORS, ...options.redactors };
    this.onTrace = options.onTrace;
  }

  get recordCount(): number {
    return this.records.length;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  async recordCommand(
    command: string,
    args: unknown,
    outcome: CommandOutcome,
    durationMs: number,
  ): Promise<void> {
    const rules = this.redactors[command] ?? {};
    const redactedOutcome: CommandOutcome = outcome.ok
      ? {
          ok: true,
          result: rules.result
            ? rules.result(outcome.result)
            : redactSensitiveKeys(outcome.result),
        }
      : outcome;
    this.records.push({
      kind: "command",
      seq: this.nextSeq(),
      command,
      // Args are recorded verbatim: replay re-invokes them. (Binary args
      // such as `push_audio_pcm` frames are not exercised by the scripted
      // session; if a future session adds them, declare the command
      // not-replayable rather than fingerprinting the arg, which would
      // corrupt the replayed invocation.)
      args,
      outcome: (await fingerprintBinary(redactedOutcome)) as CommandOutcome,
      durationMs,
    });
  }

  async recordEvent(name: string, payload: unknown): Promise<void> {
    const record: EventRecord = {
      kind: "event",
      seq: this.nextSeq(),
      name,
      payload: await fingerprintBinary(redactSensitiveKeys(payload)),
    };
    this.records.push(record);
  }

  async recordPush(subscription: string, payload: unknown): Promise<void> {
    const record: PushRecord = {
      kind: "push",
      seq: this.nextSeq(),
      subscription,
      payload: await fingerprintBinary(redactSensitiveKeys(payload)),
    };
    this.records.push(record);
  }

  buildTrace(header: Omit<TraceHeader, "schema">): Trace {
    return {
      header: { schema: "parity-trace/v1", ...header },
      records: [...this.records],
    };
  }

  /**
   * Drop everything recorded so far (boot traffic before the scripted
   * session starts is not part of the session contract).
   */
  reset(): void {
    this.records.length = 0;
    this.seq = 0;
  }

  /** Emit the completed trace to the configured sink (driver-owned lifecycle). */
  complete(header: Omit<TraceHeader, "schema">): Trace {
    const trace = this.buildTrace(header);
    if (this.onTrace) {
      this.onTrace(trace);
    }
    return trace;
  }
}

/**
 * Trace JSON-serialization compatibility helpers (used by the replay harness
 * when reconstructing channel markers).
 */
export function isChannelMarker(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("__CHANNEL__:");
}

export function channelMarkerId(marker: string): number {
  return Number(marker.slice("__CHANNEL__:".length));
}

export function isBinary(value: unknown): value is BinaryFingerprint {
  return (
    typeof value === "object" &&
    value !== null &&
    BINARY_MARKER in value &&
    typeof (value as BinaryFingerprint)[BINARY_MARKER]?.length === "number"
  );
}
