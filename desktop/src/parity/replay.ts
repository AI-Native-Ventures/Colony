/**
 * Replay harness: feeds a recorded trace to any `NativeBridge` implementation
 * and produces a structured diff — which command, which field, expected versus
 * actual, plus per-command timing deltas against the recorded baseline.
 *
 * Ordering: commands complete out of order in the trace but replay executes
 * them in trace order, so correlation is by (command, seq), never by sequence
 * position of completion.
 *
 * Volatility: both sides are canonicalized (declared per-command
 * canonicalizers + ordered value markers) so generated ids and timestamps
 * compare as shapes, not literals. Error *messages* are compared in full —
 * they are part of the native contract.
 */

import type {
  CommandOutcome,
  CommandRecord,
  EventRecord,
  PushRecord,
  Trace,
} from "@/parity/types";
import {
  NativeChannel,
  type NativeBridge,
  type NativeEvent,
  type NativeUnlisten,
} from "@/shared/api/nativeBridge";
import { isBinaryFingerprint } from "@/parity/types";
import {
  CANONICALIZERS,
  DEFAULT_CANONICALIZER,
  TraceNormalizer,
  canonicalizePushPayload,
} from "@/parity/canonicalizers";

export type FieldDiff = {
  path: string;
  expected: unknown;
  actual: unknown;
};

export type Perturbation = {
  /** Command whose outcome the harness perturbs before diffing. */
  command: string;
  /** Rewrite the outcome the bridge produced. */
  mutateOutcome: (outcome: CommandOutcome) => CommandOutcome;
};

export type ReplayCommandOptions = {
  /** Fixture arg paths that get fresh values on replay, e.g. ["name"]. */
  fixtureArgs?: string[];
  /** Arg paths that get the current epoch seconds at replay, e.g. ["before"]. */
  freshArgs?: string[];
  /**
   * Arg paths rebuilt from a captured numeric context value plus a fixed
   * offset, e.g. a page cursor at `messageCreatedAt + 1`.
   */
  offsetArgs?: Array<{ path: string; ctxKey: string; offset: number }>;
  /** Why this command is not replayed (mutating, destructive, ...). */
  notReplayableReason?: string;
  /**
   * Dynamic skip: return a reason string to skip this specific record, or
   * null to replay it (e.g. per-connection handshake commands whose
   * recorded args are only meaningful for the run that recorded them).
   */
  skipIf?: (record: CommandRecord) => string | null;
  /**
   * Option-set matcher: when the script table holds multiple option sets for
   * one command (a command used by several session steps with different
   * rewrites, e.g. `plugin:websocket|send`), the first set whose matcher
   * accepts the record applies; otherwise the last matcher-less set applies.
   */
  matchArgs?: (record: CommandRecord) => boolean;
  /**
   * Correlation captures. `result` maps a context key to a path in this
   * command's ok-result (e.g. `{ channelId: "id" }`); `args` maps a context
   * key to an arg path on this command (e.g. `{ channelId: "channelId" }`).
   * During replay, args at declared paths are rewritten from the values
   * captured by earlier commands, so commands that target an object created
   * earlier in the session follow the live object instead of the stale
   * recorded id. `"$"` is the whole value.
   */
  result?: Record<string, string>;
  args?: Record<string, string>;
  /**
   * JSON-string args that embed volatile values and must be rebuilt at
   * replay time (e.g. a relay REQ payload carrying the fixture channel id).
   * `path` is the arg path; `rewrite` maps a JSON pointer (e.g.
   * `"filter.#h.0"`) to a live context key.
   */
  jsonArgs?: Array<{ path: string; rewrite: Record<string, string> }>;
};

export type ScriptTable = Record<
  string,
  ReplayCommandOptions | ReplayCommandOptions[]
>;

export type CommandReplayResult = {
  seq: number;
  command: string;
  replayed: boolean;
  skippedReason: string | null;
  match: boolean;
  diffs: FieldDiff[];
  expectedDurationMs: number;
  actualDurationMs: number;
  deltaMs: number;
};

export type EventCoverage = {
  name: string;
  recorded: boolean;
  observedDuringReplay: boolean;
  payloadMatches: number | null;
};

export type PushCoverage = {
  subscription: string;
  recorded: number;
  observedDuringReplay: number;
  matched: number;
  missing: number;
  /** Canonical payloads recorded but never observed during replay. */
  missingPushes: unknown[];
  /** Canonical payloads observed during replay but never recorded. */
  extraPushes: unknown[];
};

export type EventNameCoverage = {
  name: string;
  status: "observed" | "unreachable" | "missing";
  reason: string | null;
};

export type ReplayReport = {
  traceSession: string;
  traceRunId: string;
  generatedAt: string;
  clean: boolean;
  summary: {
    commands: number;
    replayed: number;
    skipped: number;
    matched: number;
    diffCommands: number;
    diffCount: number;
    eventsRecorded: number;
    eventsObserved: number;
    pushSubscriptions: number;
    pushRecorded: number;
    pushObserved: number;
    pushMatched: number;
  };
  commands: CommandReplayResult[];
  events: EventCoverage[];
  eventNames: EventNameCoverage[];
  pushes: PushCoverage[];
  timing: {
    totalExpectedMs: number;
    totalActualMs: number;
    totalDeltaMs: number;
  };
  perturbations: string[];
};

export type ReplayOptions = {
  trace: Trace;
  bridge: NativeBridge;
  /** Per-command replay options (from the session script). */
  script?: ScriptTable;
  /**
   * Event names the session must cover. Every name must be observed in the
   * trace or declared unreachable, or the report is not clean.
   */
  eventNames?: string[];
  /** Event names the script cannot produce, with the reason. */
  unreachableEvents?: Record<string, string>;
  /** Fresh fixture value generator; defaults to `parity-oracle-<rand>`. */
  makeFixture?: (command: string, path: string) => string;
  /** Negative-control perturbations applied to live outcomes. */
  perturbations?: Perturbation[];
  timeoutMs?: number;
  /** Wait for async pushes/events to settle after the last command. */
  settleMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export function diffValue(
  expected: unknown,
  actual: unknown,
  path = "$",
): FieldDiff[] {
  if (Object.is(expected, actual)) {
    return [];
  }
  if (typeof expected === "number" && typeof actual === "number") {
    // Timestamps and durations legitimately differ by a few ms between runs;
    // both were normalized to `$time:n` markers already when volatile.
    return [{ path, expected, actual }];
  }
  if (typeof expected === "string" && typeof actual === "string") {
    return [{ path, expected, actual }];
  }
  if (
    typeof expected === "object" &&
    typeof actual === "object" &&
    expected !== null &&
    actual !== null
  ) {
    if (Array.isArray(expected) && Array.isArray(actual)) {
      if (expected.length !== actual.length) {
        return [{ path, expected, actual }];
      }
      const diffs: FieldDiff[] = [];
      for (let i = 0; i < expected.length; i += 1) {
        diffs.push(...diffValue(expected[i], actual[i], `${path}[${i}]`));
      }
      return diffs;
    }
    if (Array.isArray(expected) || Array.isArray(actual)) {
      return [{ path, expected, actual }];
    }
    const expectedKeys = Object.keys(
      expected as Record<string, unknown>,
    ).sort();
    const actualKeys = Object.keys(actual as Record<string, unknown>).sort();
    if (expectedKeys.join(",") !== actualKeys.join(",")) {
      return [{ path, expected, actual }];
    }
    const diffs: FieldDiff[] = [];
    for (const key of expectedKeys) {
      diffs.push(
        ...diffValue(
          (expected as Record<string, unknown>)[key],
          (actual as Record<string, unknown>)[key],
          `${path}.${key}`,
        ),
      );
    }
    return diffs;
  }
  return [{ path, expected, actual }];
}

function normalizeCommandValue(
  normalizer: TraceNormalizer,
  command: string,
  value: unknown,
): unknown {
  const canonicalizer = CANONICALIZERS[command] ?? DEFAULT_CANONICALIZER;
  return normalizer.normalize(canonicalizer(value));
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function defaultFixture(): string {
  return `parity-oracle-${randomHex(6)}`;
}

function setPath(root: unknown, path: string, value: unknown): unknown {
  const segments = path.split(".");
  const walk = (node: unknown, index: number): unknown => {
    if (node === null || typeof node !== "object") {
      return node;
    }
    const obj = node as Record<string, unknown>;
    const key = segments[index];
    const copy = Array.isArray(obj)
      ? ([...obj] as unknown as Record<string, unknown>)
      : { ...obj };
    if (index === segments.length - 1) {
      copy[key] = value;
      return copy;
    }
    copy[key] = walk(obj[key], index + 1);
    return copy;
  };
  return walk(root, 0);
}

function getPath(root: unknown, path: string): unknown {
  let node = root;
  for (const segment of path.split(".")) {
    if (node === null || typeof node !== "object") {
      return undefined;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function deepClone<T>(value: T): T {
  // Commands without args record `args: undefined`; JSON.parse(undefined)
  // throws, so pass undefined through untouched.
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

type ReplayRuntime = {
  /** Recorded channel marker (`__CHANNEL__:<recordedId>`) -> live channel. */
  channelMap: Map<string, NativeChannel>;
  /**
   * Oracle-assigned live channel id -> recorded channel marker (reverse of
   * channelMap). The seam's `NativeChannel` carries no id; the harness
   * assigns its own so pushes can be correlated back to the recorded
   * subscription.
   */
  liveChannelMarkers: Map<number, string>;
  /** Next oracle-assigned channel id. */
  nextChannelId: number;
  /** Recorded channel UUID -> live channel UUID (correlation). */
  channelIdMap: Map<string, string>;
  /** Recorded ws connection id -> live ws connection id. */
  wsIdMap: Map<number, number>;
  /** Recorded ws connection id -> its recorded channel marker. */
  wsChannelMarkers: Map<number, string>;
  /** Recorded message event id -> live message event id (e-tag pushes). */
  messageIdMap: Map<string, string>;
  liveEvents: EventRecord[];
  livePushes: PushRecord[];
  unlistens: NativeUnlisten[];
  /** Correlation captures: ctxKey -> live value from a previous command. */
  liveCtx: Map<string, unknown>;
};

export async function replayTrace(
  options: ReplayOptions,
): Promise<ReplayReport> {
  const {
    trace,
    bridge,
    script = {},
    makeFixture = defaultFixture,
    perturbations = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    settleMs = 2_000,
    eventNames = [],
    unreachableEvents = {},
  } = options;

  // Two stateful normalizers: expected (recorded) and actual (live). The
  // marker assignment is first-seen order, and the two sides are normalized
  // at different times (recorded pushes first, live pushes after settling),
  // so sharing one instance would give the same value different markers on
  // each side. Both sides see the same deterministic value sequence, so
  // per-side markers align.
  const expectedNormalizer = new TraceNormalizer();
  const actualNormalizer = new TraceNormalizer();
  const runtime: ReplayRuntime = {
    channelMap: new Map(),
    liveChannelMarkers: new Map(),
    nextChannelId: 1,
    channelIdMap: new Map(),
    wsIdMap: new Map(),
    wsChannelMarkers: new Map(),
    messageIdMap: new Map(),
    liveEvents: [],
    livePushes: [],
    unlistens: [],
    liveCtx: new Map(),
  };

  const perturbationByCommand = new Map(
    perturbations.map((p) => [p.command, p]),
  );

  // Register a passive listener for every event name present in the trace so
  // replay observes the same event surface the recording did.
  const traceEventNames = new Set<string>();
  for (const record of trace.records) {
    if (record.kind === "event") {
      traceEventNames.add(record.name);
    }
  }
  for (const name of traceEventNames) {
    void bridge
      .listen<unknown>(name, (event: NativeEvent<unknown>) => {
        runtime.liveEvents.push({
          kind: "event",
          seq: 0,
          name,
          payload: event.payload,
        });
      })
      .then((unlisten) => {
        runtime.unlistens.push(unlisten);
      });
  }

  // Keepalive pings (`{type: "Ping", data: []}`) are relay-connection
  // noise, not subscription traffic: their cadence is a function of session
  // length, so record and replay never produce the same count. Exclude them
  // from push accounting on both sides — the subscription contract is the
  // EVENT/OK/EOSE/CLOSED payloads.
  const isKeepalivePing = (payload: unknown): boolean => {
    return (
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>).type === "Ping"
    );
  };

  const results: CommandReplayResult[] = [];
  const recordedEvents: EventRecord[] = [];
  const recordedPushes: PushRecord[] = [];

  for (const record of trace.records) {
    if (record.kind === "event") {
      recordedEvents.push(record);
    } else if (record.kind === "push") {
      recordedPushes.push(record);
    }
  }

  for (const record of trace.records) {
    if (record.kind !== "command") {
      continue;
    }
    results.push(
      await replayCommand(record, runtime, {
        bridge,
        script,
        makeFixture,
        perturbationByCommand,
        expectedNormalizer,
        actualNormalizer,
        timeoutMs,
        relayUrl: trace.header.relayUrl,
        runtime,
      }),
    );
  }

  await settle(settleMs);

  // Push matching: recorded pushes on `__CHANNEL__:X` compare against live
  // pushes on the mapped fresh channel, by canonicalized payload content.
  const pushes: PushCoverage[] = [];
  const missingPushes = new Map<string, unknown[]>();
  const extraPushes = new Map<string, unknown[]>();
  for (const record of recordedPushes) {
    if (isKeepalivePing(record.payload)) {
      continue;
    }
    const coverage = pushes.find((p) => p.subscription === record.subscription);
    if (coverage) {
      coverage.recorded += 1;
    } else {
      pushes.push({
        subscription: record.subscription,
        recorded: 1,
        observedDuringReplay: 0,
        matched: 0,
        missing: 0,
        missingPushes: [],
        extraPushes: [],
      });
    }
  }
  for (const live of runtime.livePushes) {
    if (isKeepalivePing(live.payload)) {
      continue;
    }
    const key = livePushMarkerFor(live.subscription, runtime);
    const coverage = pushes.find((p) => p.subscription === key);
    if (coverage) {
      coverage.observedDuringReplay += 1;
    }
  }
  // Content match: for each recorded push, find an unmatched live push on the
  // mapped channel with the same canonicalized payload.
  const usedLive = new Set<number>();
  for (const record of recordedPushes) {
    if (isKeepalivePing(record.payload)) {
      continue;
    }
    const coverage = pushes.find((p) => p.subscription === record.subscription);
    if (!coverage) {
      continue;
    }
    // Pushes are wire payloads (["EVENT", {...}], wrapped as {type, data})
    // whose event ids, signatures, timestamps, challenges and subscription
    // labels are per-run; both sides reduce to the event contract before
    // comparing, and recorded channel ids remap to the live channel so the
    // h tags correlate.
    const recordedNorm = expectedNormalizer.normalize(
      canonicalizePushPayload(remapCorrelatedIds(record.payload, runtime)),
    );
    let matchedIndex = -1;
    const matchedLive = runtime.livePushes.find((live, index) => {
      if (usedLive.has(index)) {
        return false;
      }
      if (
        livePushMarkerFor(live.subscription, runtime) !== record.subscription
      ) {
        return false;
      }
      const matches =
        JSON.stringify(
          actualNormalizer.normalize(canonicalizePushPayload(live.payload)),
        ) === JSON.stringify(recordedNorm);
      if (matches) {
        matchedIndex = index;
      }
      return matches;
    });
    if (matchedLive) {
      usedLive.add(matchedIndex);
      coverage.matched += 1;
    } else {
      coverage.missing += 1;
      const key = record.subscription;
      const list = missingPushes.get(key) ?? [];
      list.push(recordedNorm);
      missingPushes.set(key, list);
    }
  }
  for (let index = 0; index < runtime.livePushes.length; index += 1) {
    const live = runtime.livePushes[index];
    if (isKeepalivePing(live.payload)) {
      continue;
    }
    if (usedLive.has(index)) {
      continue;
    }
    const key = livePushMarkerFor(live.subscription, runtime);
    const list = extraPushes.get(key) ?? [];
    list.push(
      actualNormalizer.normalize(canonicalizePushPayload(live.payload)),
    );
    extraPushes.set(key, list);
  }
  for (const coverage of pushes) {
    coverage.missingPushes = missingPushes.get(coverage.subscription) ?? [];
    coverage.extraPushes = extraPushes.get(coverage.subscription) ?? [];
  }

  const eventCoverage: EventCoverage[] = [];
  for (const record of recordedEvents) {
    const existing = eventCoverage.find((e) => e.name === record.name);
    if (existing) {
      continue;
    }
    const observed = runtime.liveEvents.filter((e) => e.name === record.name);
    let payloadMatches: number | null = null;
    if (observed.length > 0) {
      payloadMatches = 0;
      for (const live of observed) {
        const expected = expectedNormalizer.normalize(record.payload);
        const actual = actualNormalizer.normalize(live.payload);
        if (JSON.stringify(expected) === JSON.stringify(actual)) {
          payloadMatches += 1;
        }
      }
    }
    eventCoverage.push({
      name: record.name,
      recorded: true,
      observedDuringReplay: observed.length > 0,
      payloadMatches,
    });
  }

  const replayed = results.filter((r) => r.replayed);
  const matched = replayed.filter((r) => r.match);
  const diffCommands = replayed.filter((r) => r.diffs.length > 0);
  const diffCount = diffCommands.reduce((acc, r) => acc + r.diffs.length, 0);

  for (const unlisten of runtime.unlistens) {
    unlisten();
  }

  const summary = {
    commands: results.length,
    replayed: replayed.length,
    skipped: results.length - replayed.length,
    matched: matched.length,
    diffCommands: diffCommands.length,
    diffCount,
    eventsRecorded: recordedEvents.length,
    eventsObserved: runtime.liveEvents.length,
    pushSubscriptions: pushes.length,
    pushRecorded: recordedPushes.filter((p) => !isKeepalivePing(p.payload))
      .length,
    pushObserved: runtime.livePushes.filter((p) => !isKeepalivePing(p.payload))
      .length,
    pushMatched: pushes.reduce((acc, p) => acc + p.matched, 0),
  };

  // Event-name coverage: every required name is observed in the trace or
  // explicitly declared unreachable with a reason.
  const recordedEventNames = new Set(recordedEvents.map((e) => e.name));
  const eventNamesCoverage: EventNameCoverage[] = eventNames.map((name) => {
    if (recordedEventNames.has(name)) {
      return { name, status: "observed", reason: null };
    }
    const reason = unreachableEvents[name];
    if (reason !== undefined) {
      return { name, status: "unreachable", reason };
    }
    return { name, status: "missing", reason: null };
  });
  const eventNamesCovered =
    eventNamesCoverage.every((c) => c.status !== "missing") ||
    eventNames.length === 0;

  return {
    traceSession: trace.header.session,
    traceRunId: trace.header.runId,
    generatedAt: new Date().toISOString(),
    clean:
      diffCount === 0 &&
      pushes.every((p) => p.missing === 0) &&
      summary.eventsRecorded > 0 &&
      eventNamesCovered,
    summary,
    commands: results,
    events: eventCoverage,
    eventNames: eventNamesCoverage,
    pushes,
    timing: {
      totalExpectedMs: replayed.reduce(
        (acc, r) => acc + r.expectedDurationMs,
        0,
      ),
      totalActualMs: replayed.reduce((acc, r) => acc + r.actualDurationMs, 0),
      totalDeltaMs: replayed.reduce((acc, r) => acc + r.deltaMs, 0),
    },
    perturbations: perturbations.map((p) => p.command),
  };
}

async function replayCommand(
  record: CommandRecord,
  runtime: ReplayRuntime,
  deps: {
    bridge: NativeBridge;
    script: ScriptTable;
    makeFixture: (command: string, path: string) => string;
    perturbationByCommand: Map<string, Perturbation>;
    expectedNormalizer: TraceNormalizer;
    actualNormalizer: TraceNormalizer;
    timeoutMs: number;
    relayUrl: string | null;
    runtime: ReplayRuntime;
  },
): Promise<CommandReplayResult> {
  const scriptEntry = deps.script[record.command];
  const options: ReplayCommandOptions = Array.isArray(scriptEntry)
    ? (scriptEntry.find((candidate) => candidate.matchArgs?.(record)) ??
      scriptEntry[scriptEntry.length - 1] ??
      {})
    : (scriptEntry ?? {});
  const base: CommandReplayResult = {
    seq: record.seq,
    command: record.command,
    replayed: true,
    skippedReason: null,
    match: true,
    diffs: [],
    expectedDurationMs: record.durationMs,
    actualDurationMs: 0,
    deltaMs: 0,
  };

  const skipReason =
    options.notReplayableReason ??
    (options.skipIf ? options.skipIf(record) : null);
  if (skipReason) {
    return { ...base, replayed: false, skippedReason: skipReason };
  }

  // Binary command payloads are recorded as fingerprints (hash + length,
  // never the bytes), so the recorded args cannot be re-invoked. The
  // scripted session does not exercise `push_audio_pcm`; a future session
  // that does must declare these commands not-replayable.
  if (containsBinaryFingerprint(record.args)) {
    return {
      ...base,
      replayed: false,
      skippedReason:
        "binary payloads are recorded as fingerprints (hash + length), not replayable",
    };
  }

  // Build replay args: fresh fixture values + correlation captures +
  // channel/ws id remapping.
  let args = deepClone(record.args);
  for (const path of options.fixtureArgs ?? []) {
    const current = getPath(args, path);
    if (typeof current === "string") {
      args = setPath(args, path, deps.makeFixture(record.command, path));
    }
  }
  for (const [ctxKey, argPath] of Object.entries(options.args ?? {})) {
    const live = deps.runtime.liveCtx.get(ctxKey);
    if (live !== undefined) {
      args = setPath(args, argPath, live);
    }
  }
  for (const path of options.freshArgs ?? []) {
    args = setPath(args, path, Math.floor(Date.now() / 1000));
  }
  for (const { path, ctxKey, offset } of options.offsetArgs ?? []) {
    const live = deps.runtime.liveCtx.get(ctxKey);
    if (typeof live === "number") {
      args = setPath(args, path, live + offset);
    }
  }
  for (const { path, rewrite } of options.jsonArgs ?? []) {
    const current = getPath(args, path);
    if (typeof current !== "string") {
      continue;
    }
    try {
      let parsed = JSON.parse(current) as unknown;
      for (const [pointer, ctxKey] of Object.entries(rewrite)) {
        const live = deps.runtime.liveCtx.get(ctxKey);
        if (live !== undefined) {
          parsed = setPath(parsed, pointer, live);
        }
      }
      args = setPath(args, path, JSON.stringify(parsed));
    } catch {
      // Unparseable payloads pass through untouched (recorded as-is).
    }
  }
  args = remapChannelsAndWsIds(args, deps.runtime, deps.bridge);

  const startedAt = performance.now();
  let liveOutcome: CommandOutcome;
  if (isAuthSend(record)) {
    // NIP-42 AUTH sends carry a challenge-signed event; the recorded event
    // is stale by construction. Re-sign with the live challenge instead of
    // replaying the recorded bytes (the relay rejects stale challenges).
    liveOutcome = await replayAuthSend(
      record,
      deps.runtime,
      deps.bridge,
      deps.relayUrl,
      deps.timeoutMs,
    );
  } else {
    try {
      const result = await withTimeout(
        deps.bridge.invoke(
          record.command,
          args as Record<string, unknown> | undefined,
        ),
        deps.timeoutMs,
        `replay of ${record.command} timed out`,
      );
      liveOutcome = { ok: true, result };
    } catch (error) {
      liveOutcome = {
        ok: false,
        error: { message: errorMessageOf(error) },
      };
    }
  }
  const actualDurationMs = performance.now() - startedAt;

  // Capture correlated values from the LIVE outcome before perturbation,
  // so subsequent commands follow the live object.
  if (liveOutcome.ok) {
    for (const [ctxKey, resultPath] of Object.entries(options.result ?? {})) {
      const value =
        resultPath === "$"
          ? liveOutcome.result
          : getPath(liveOutcome.result, resultPath);
      if (value !== undefined) {
        deps.runtime.liveCtx.set(ctxKey, value);
      }
    }
  }

  // Correlate message ids: pushes for reactions, deletes and edits carry the
  // parent message's event id as an e-tag. The live id differs per run, so
  // the recorded id maps to the live id for push payload remapping.
  if (liveOutcome.ok && record.outcome.ok) {
    const messagePath = options.result?.messageId;
    if (typeof messagePath === "string") {
      const recordedId = getPath(record.outcome.result, messagePath);
      const liveId = getPath(liveOutcome.result, messagePath);
      if (
        typeof recordedId === "string" &&
        typeof liveId === "string" &&
        recordedId !== liveId
      ) {
        deps.runtime.messageIdMap.set(recordedId, liveId);
      }
    }
  }

  // Correlate the fixture channel: every recorded result carrying the
  // recorded channel UUID must compare against the live channel's UUID.
  if (
    record.command === "create_channel" &&
    record.outcome.ok &&
    liveOutcome.ok
  ) {
    const recordedId = getPath(record.outcome.result, "id");
    const liveId = getPath(liveOutcome.result, "id");
    if (
      typeof recordedId === "string" &&
      typeof liveId === "string" &&
      recordedId !== liveId
    ) {
      deps.runtime.channelIdMap.set(recordedId, liveId);
    }
  }

  // Apply negative-control perturbations to the live outcome.
  const perturbation = deps.perturbationByCommand.get(record.command);
  if (perturbation) {
    liveOutcome = perturbation.mutateOutcome(liveOutcome);
  }

  const expectedNorm = normalizeOutcome(
    deps.expectedNormalizer,
    record.command,
    remapCorrelatedIds(record.outcome, deps.runtime) as CommandOutcome,
  );
  const actualNorm = normalizeOutcome(
    deps.actualNormalizer,
    record.command,
    liveOutcome,
  );
  const diffs = diffOutcome(expectedNorm, actualNorm);

  // Track ws ids produced by replayed connections for later arg rewrites,
  // and remember which recorded channel marker each connection used so the
  // AUTH rewrite and push matching can find the live channel.
  if (
    record.command === "plugin:websocket|connect" &&
    record.outcome.ok &&
    typeof record.outcome.result === "number" &&
    liveOutcome.ok &&
    typeof liveOutcome.result === "number"
  ) {
    runtime.wsIdMap.set(record.outcome.result, liveOutcome.result);
    const marker = getPath(record.args, "onMessage");
    if (typeof marker === "string" && marker.startsWith("__CHANNEL__:")) {
      runtime.wsChannelMarkers.set(record.outcome.result, marker);
    }
  }

  return {
    ...base,
    match: diffs.length === 0,
    diffs,
    actualDurationMs,
    deltaMs: actualDurationMs - record.durationMs,
  };
}

function normalizeOutcome(
  normalizer: TraceNormalizer,
  command: string,
  outcome: CommandOutcome,
): CommandOutcome {
  if (outcome.ok) {
    return {
      ok: true,
      result: normalizeCommandValue(normalizer, command, outcome.result),
    };
  }
  return {
    ok: false,
    error: { message: normalizeErrorString(normalizer, outcome.error.message) },
  };
}

/** Error messages are data — normalize volatile values inside, nothing else. */
function normalizeErrorString(
  normalizer: TraceNormalizer,
  message: string,
): string {
  const normalized = normalizer.normalize(message);
  return typeof normalized === "string" ? normalized : message;
}

function diffOutcome(
  expected: CommandOutcome,
  actual: CommandOutcome,
): FieldDiff[] {
  if (expected.ok && actual.ok) {
    return diffValue(expected.result, actual.result);
  }
  if (!expected.ok && !actual.ok) {
    if (expected.error.message !== actual.error.message) {
      return [
        {
          path: "$.error.message",
          expected: expected.error.message,
          actual: actual.error.message,
        },
      ];
    }
    return [];
  }
  return [
    {
      path: "$",
      expected: expected.ok ? "ok" : `error: ${expected.error.message}`,
      actual: actual.ok ? "ok" : `error: ${actual.error.message}`,
    },
  ];
}

function remapChannelsAndWsIds(
  args: unknown,
  runtime: ReplayRuntime,
  bridge: NativeBridge,
): unknown {
  if (Array.isArray(args)) {
    return args.map((item) => remapChannelsAndWsIds(item, runtime, bridge));
  }
  if (typeof args === "object" && args !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      args as Record<string, unknown>,
    )) {
      if (typeof value === "string" && value.startsWith("__CHANNEL__:")) {
        out[key] = channelArgFor(value, runtime, bridge);
      } else if (typeof value === "number" && runtime.wsIdMap.has(value)) {
        out[key] = runtime.wsIdMap.get(value);
      } else {
        out[key] = remapChannelsAndWsIds(value, runtime, bridge);
      }
    }
    return out;
  }
  return args;
}

function channelArgFor(
  marker: string,
  runtime: ReplayRuntime,
  _bridge: NativeBridge,
): unknown {
  const existing = runtime.channelMap.get(marker);
  if (existing) {
    return existing;
  }
  const id = runtime.nextChannelId;
  runtime.nextChannelId += 1;
  const channel = new NativeChannel<unknown>((message) => {
    runtime.livePushes.push({
      kind: "push",
      seq: 0,
      subscription: `__CHANNEL__:${id}`,
      payload: message,
    });
  });
  runtime.channelMap.set(marker, channel);
  runtime.liveChannelMarkers.set(id, marker);
  return channel;
}

/** Whether a value (deeply) contains a `{$binary: ...}` fingerprint. */
function containsBinaryFingerprint(value: unknown): boolean {
  if (isBinaryFingerprint(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsBinaryFingerprint(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).some((item) =>
      containsBinaryFingerprint(item),
    );
  }
  return false;
}

/**
 * Map a live push's subscription back to the recorded channel marker it
 * corresponds to (live channel ids differ per run), or pass it through for
 * channels the replay did not create (the app's own relay connection).
 */
function livePushMarkerFor(
  subscription: string,
  runtime: ReplayRuntime,
): string {
  const match = /^__CHANNEL__:(\d+)$/.exec(subscription);
  if (match) {
    const marker = runtime.liveChannelMarkers.get(Number(match[1]));
    if (marker) {
      return marker;
    }
  }
  return subscription;
}

/**
 * Replace correlated per-run ids in a recorded value with their live
 * counterparts before normalization: the fixture channel UUID (recorded id
 * -> live id) and ws connection ids. Applies to strings (including JSON
 * strings and error messages) and nested structures. No-op when no
 * correlations exist yet.
 */
function remapCorrelatedIds(value: unknown, runtime: ReplayRuntime): unknown {
  if (
    runtime.channelIdMap.size === 0 &&
    runtime.wsIdMap.size === 0 &&
    runtime.messageIdMap.size === 0
  ) {
    return value;
  }
  if (typeof value === "string") {
    let out = value;
    for (const [recorded, live] of runtime.channelIdMap) {
      if (recorded !== live && out.includes(recorded)) {
        out = out.split(recorded).join(live);
      }
    }
    for (const [recorded, live] of runtime.wsIdMap) {
      const recordedStr = String(recorded);
      const liveStr = String(live);
      if (recorded !== live && out.includes(recordedStr)) {
        out = out.split(recordedStr).join(liveStr);
      }
    }
    for (const [recorded, live] of runtime.messageIdMap) {
      if (recorded !== live && out.includes(recorded)) {
        out = out.split(recorded).join(live);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => remapCorrelatedIds(item, runtime));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = remapCorrelatedIds(item, runtime);
    }
    return out;
  }
  return value;
}

/** A `plugin:websocket|send` whose payload is a NIP-42 AUTH wire message. */
function isAuthSend(record: CommandRecord): boolean {
  if (record.command !== "plugin:websocket|send") {
    return false;
  }
  const data = getPath(record.args, "message.data");
  if (typeof data !== "string") {
    return false;
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    return Array.isArray(parsed) && parsed[0] === "AUTH";
  } catch {
    return false;
  }
}

/**
 * Replay a recorded NIP-42 AUTH send. The recorded AUTH event was signed
 * against the record run's challenge; the relay rejects stale challenges, so
 * the harness waits for the live AUTH challenge on the mapped channel,
 * signs a fresh auth event (`create_auth_event`), and sends it on the live
 * connection. The recorded outcome (an ok unit result) is reproduced.
 */
async function replayAuthSend(
  record: CommandRecord,
  runtime: ReplayRuntime,
  bridge: NativeBridge,
  relayUrl: string | null,
  timeoutMs: number,
): Promise<CommandOutcome> {
  const recordedWsId = getPath(record.args, "id");
  const liveWsId =
    typeof recordedWsId === "number"
      ? runtime.wsIdMap.get(recordedWsId)
      : undefined;
  const marker =
    typeof recordedWsId === "number"
      ? runtime.wsChannelMarkers.get(recordedWsId)
      : undefined;
  const channel = marker ? runtime.channelMap.get(marker) : undefined;
  if (liveWsId === undefined || channel === undefined || marker === undefined) {
    return {
      ok: false,
      error: {
        message: `parity: no live websocket/channel mapping for recorded connection ${String(recordedWsId)}`,
      },
    };
  }

  const challenge = await waitForLiveAuthChallenge(runtime, marker, timeoutMs);
  if (challenge === null) {
    return {
      ok: false,
      error: { message: "parity: no live AUTH challenge received" },
    };
  }

  const eventJson = await withTimeout(
    bridge.invoke("create_auth_event", {
      challenge,
      relayUrl: relayUrl ?? "ws://localhost:3000",
    }),
    timeoutMs,
    "replay of create_auth_event timed out",
  );
  let event: unknown = eventJson;
  if (typeof eventJson === "string") {
    try {
      event = JSON.parse(eventJson) as unknown;
    } catch {
      // Keep the raw string; the send below serializes it as-is.
    }
  }
  await withTimeout(
    bridge.invoke("plugin:websocket|send", {
      id: liveWsId,
      message: {
        type: "Text",
        data: JSON.stringify(["AUTH", event]),
      },
    }),
    timeoutMs,
    "replay of AUTH send timed out",
  );
  return { ok: true, result: null };
}

/**
 * Wait for the relay's AUTH challenge push on the live channel. The push
 * arrives asynchronously after the replayed connect; poll the observed push
 * stream (bounded by the command timeout).
 */
async function waitForLiveAuthChallenge(
  runtime: ReplayRuntime,
  marker: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    for (const push of runtime.livePushes) {
      if (livePushMarkerFor(push.subscription, runtime) !== marker) {
        continue;
      }
      const payload = push.payload as
        | { type?: unknown; data?: unknown }
        | undefined;
      if (
        typeof payload !== "object" ||
        payload === null ||
        payload.type !== "Text" ||
        typeof payload.data !== "string"
      ) {
        continue;
      }
      try {
        const parsed = JSON.parse(payload.data) as unknown;
        if (
          Array.isArray(parsed) &&
          parsed[0] === "AUTH" &&
          typeof parsed[1] === "string"
        ) {
          return parsed[1];
        }
      } catch {
        // Not a wire array; keep waiting.
      }
    }
    await settle(50);
  }
  return null;
}

function errorMessageOf(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const candidate = (error as Record<string, unknown>).message;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return String(error);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Diff two traces (recorded before/after a change) without a live bridge.
 * Correlation is by (command, seq); values are canonicalized per command.
 */
export function diffTraces(
  before: Trace,
  after: Trace,
): {
  clean: boolean;
  commandDiffs: Array<{ seq: number; command: string; diffs: FieldDiff[] }>;
  eventDiffs: Array<{ name: string; before: number; after: number }>;
  pushDiffs: Array<{ subscription: string; before: number; after: number }>;
} {
  const beforeNorm = new TraceNormalizer();
  const afterNorm = new TraceNormalizer();
  const beforeCommands = before.records.filter(
    (r): r is CommandRecord => r.kind === "command",
  );
  const afterCommands = after.records.filter(
    (r): r is CommandRecord => r.kind === "command",
  );

  const commandDiffs: Array<{
    seq: number;
    command: string;
    diffs: FieldDiff[];
  }> = [];
  for (
    let i = 0;
    i < Math.max(beforeCommands.length, afterCommands.length);
    i += 1
  ) {
    const b = beforeCommands[i];
    const a = afterCommands[i];
    if (!b || !a) {
      commandDiffs.push({
        seq: i,
        command: b?.command ?? a?.command ?? "?",
        diffs: [
          {
            path: "$",
            expected: b ? "present" : "absent",
            actual: a ? "present" : "absent",
          },
        ],
      });
      continue;
    }
    if (b.command !== a.command) {
      commandDiffs.push({
        seq: i,
        command: b.command,
        diffs: [{ path: "$.command", expected: b.command, actual: a.command }],
      });
      continue;
    }
    const expected = normalizeOutcome(beforeNorm, b.command, b.outcome);
    const actual = normalizeOutcome(afterNorm, a.command, a.outcome);
    const diffs = diffOutcome(expected, actual);
    if (diffs.length > 0) {
      commandDiffs.push({ seq: i, command: b.command, diffs });
    }
  }

  const eventNames = new Set<string>();
  for (const record of [...before.records, ...after.records]) {
    if (record.kind === "event") {
      eventNames.add(record.name);
    }
  }
  const eventDiffs: Array<{ name: string; before: number; after: number }> = [];
  for (const name of eventNames) {
    const beforeCount = before.records.filter(
      (r): r is EventRecord => r.kind === "event" && r.name === name,
    ).length;
    const afterCount = after.records.filter(
      (r): r is EventRecord => r.kind === "event" && r.name === name,
    ).length;
    if (beforeCount !== afterCount) {
      eventDiffs.push({ name, before: beforeCount, after: afterCount });
    }
  }

  const pushKeys = new Set<string>();
  for (const record of [...before.records, ...after.records]) {
    if (record.kind === "push") {
      pushKeys.add(record.subscription);
    }
  }
  const pushDiffs: Array<{
    subscription: string;
    before: number;
    after: number;
  }> = [];
  for (const key of pushKeys) {
    const beforeCount = before.records.filter(
      (r): r is PushRecord => r.kind === "push" && r.subscription === key,
    ).length;
    const afterCount = after.records.filter(
      (r): r is PushRecord => r.kind === "push" && r.subscription === key,
    ).length;
    if (beforeCount !== afterCount) {
      pushDiffs.push({
        subscription: key,
        before: beforeCount,
        after: afterCount,
      });
    }
  }

  return {
    clean:
      commandDiffs.length === 0 &&
      eventDiffs.length === 0 &&
      pushDiffs.length === 0,
    commandDiffs,
    eventDiffs,
    pushDiffs,
  };
}
