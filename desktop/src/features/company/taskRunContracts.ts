import { verifyEvent } from "nostr-tools/pure";

import type { RelayEvent } from "../../shared/api/types.ts";
import { KIND_JOB_HEAD } from "../../shared/constants/kinds.ts";

const HEX_64 = /^[0-9a-f]{64}$/i;
const RUN_STATUSES = [
  "queued",
  "executing",
  "recoverable",
  "delivered",
  "failed",
  "abandoned",
] as const;
const ARTIFACT_KINDS = ["event", "url", "path", "text"] as const;

function expectedRunStatus(
  status: string,
  attempts: number,
): TaskRunStatus | null {
  switch (status) {
    case "open":
      return attempts === 0 ? "queued" : "recoverable";
    case "leased":
      return "executing";
    case "done":
      return "delivered";
    case "failed":
      return "failed";
    case "abandoned":
      return "abandoned";
    default:
      return null;
  }
}

export type TaskRunStatus = (typeof RUN_STATUSES)[number];
export type TaskArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type TaskArtifact = {
  kind: TaskArtifactKind;
  reference: string;
  label: string | null;
};

export type TaskRunCheckpoint = {
  sequence: number;
  summary: string;
  progress: number | null;
  eventId: string;
};

export type TaskRunHead = {
  eventId: string;
  jobId: string;
  employeePubkey: string;
  originatorPubkey: string;
  filedByPubkey: string;
  taskId: string;
  channelId: string;
  threadId: string;
  runStatus: TaskRunStatus;
  attempts: number;
  leaseHolderPubkey: string | null;
  leaseExpiresAt: number | null;
  instruction: string;
  result: string | null;
  failure: string | null;
  checkpoint: TaskRunCheckpoint | null;
  artifacts: TaskArtifact[];
  outcomeEventId: string | null;
  createdAt: number;
};

export type TaskRunContext = {
  taskId: string;
  channelId: string;
  threadId: string;
};

export type TaskRunParseResult =
  | { ok: true; value: TaskRunHead }
  | { ok: false; message: string };

function failure(message: string): TaskRunParseResult {
  return { ok: false, message };
}

function singleTag(event: RelayEvent, name: string): string | null {
  const matches = event.tags.filter((tag) => tag[0] === name);
  return matches.length === 1 && matches[0]?.length === 2
    ? (matches[0][1] ?? null)
    : null;
}

function optionalTag(
  event: RelayEvent,
  name: string,
): { ok: true; value: string | null } | { ok: false } {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (matches.length === 0) return { ok: true, value: null };
  if (matches.length !== 1 || matches[0]?.length !== 2) return { ok: false };
  return { ok: true, value: matches[0]?.[1] ?? null };
}

function validSignedEvent(event: RelayEvent): boolean {
  try {
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    });
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && [...trimmed].length <= max ? trimmed : null;
}

function parseArtifact(value: unknown): TaskArtifact | null {
  if (!isRecord(value)) return null;
  if (
    Object.keys(value).some((key) => !["kind", "ref", "label"].includes(key)) ||
    !(ARTIFACT_KINDS as readonly unknown[]).includes(value.kind)
  ) {
    return null;
  }
  const reference = boundedText(value.ref, 4_000);
  if (!reference) return null;
  if (value.kind === "event" && !HEX_64.test(reference)) return null;
  const label = value.label === null ? null : boundedText(value.label, 4_000);
  if (value.label !== null && !label) return null;
  return {
    kind: value.kind as TaskArtifactKind,
    reference,
    label,
  };
}

/** Parse one signed canonical Job head in an exact task/channel/thread scope. */
export function parseTaskRunHead(
  event: RelayEvent,
  context: TaskRunContext,
): TaskRunParseResult {
  if (event.kind !== KIND_JOB_HEAD || !validSignedEvent(event)) {
    return failure("invalid Job head event");
  }
  const required = {
    jobId: singleTag(event, "d"),
    employee: singleTag(event, "employee"),
    originator: singleTag(event, "originator"),
    filedBy: singleTag(event, "filed-by"),
    status: singleTag(event, "status"),
    attempts: singleTag(event, "attempts"),
    taskId: singleTag(event, "task"),
    channelId: singleTag(event, "h"),
    threadId: singleTag(event, "e"),
    originatorP: singleTag(event, "p"),
    runStatus: singleTag(event, "run-status"),
  };
  if (
    !required.jobId ||
    !HEX_64.test(required.jobId) ||
    !required.employee ||
    !HEX_64.test(required.employee) ||
    !required.originator ||
    !HEX_64.test(required.originator) ||
    event.pubkey.toLowerCase() !== required.employee.toLowerCase() ||
    required.originatorP !== required.originator ||
    !required.filedBy ||
    !HEX_64.test(required.filedBy) ||
    !required.taskId ||
    required.taskId !== context.taskId ||
    required.channelId !== context.channelId ||
    required.threadId !== context.threadId ||
    !required.runStatus ||
    !(RUN_STATUSES as readonly string[]).includes(required.runStatus)
  ) {
    return failure("Job head tags are invalid or outside the task context");
  }
  const attempts = Number(required.attempts);
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    return failure("Job attempts are invalid");
  }
  if (
    expectedRunStatus(required.status ?? "", attempts) !== required.runStatus
  ) {
    return failure("Job status and Task run status disagree");
  }

  const optionalNames = [
    "lease-holder",
    "lease-expires",
    "checkpoint-seq",
    "checkpoint-event",
    "outcome-event",
  ] as const;
  const optional = Object.fromEntries(
    optionalNames.map((name) => [name, optionalTag(event, name)]),
  ) as Record<(typeof optionalNames)[number], ReturnType<typeof optionalTag>>;
  if (Object.values(optional).some((entry) => !entry.ok)) {
    return failure("Job head singleton tags are duplicated");
  }
  const optionalValue = (name: (typeof optionalNames)[number]) =>
    optional[name].ok ? optional[name].value : null;
  const leaseHolder = optionalValue("lease-holder");
  const leaseExpiresRaw = optionalValue("lease-expires");
  const leaseExpiresAt =
    leaseExpiresRaw === null ? null : Number(leaseExpiresRaw);
  if (
    (leaseHolder !== null && !HEX_64.test(leaseHolder)) ||
    (leaseExpiresRaw !== null && !Number.isSafeInteger(leaseExpiresAt)) ||
    (required.runStatus === "executing" &&
      (leaseHolder === null || leaseExpiresAt === null))
  ) {
    return failure("Job lease is invalid");
  }

  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    return failure("Job head content is not JSON");
  }
  if (!isRecord(content)) return failure("Job head content is not an object");
  if (
    Object.keys(content).some(
      (key) =>
        ![
          "instruction",
          "result",
          "failure",
          "checkpoint",
          "artifacts",
        ].includes(key),
    )
  ) {
    return failure("Job head content contains unknown fields");
  }
  const instruction = boundedText(content.instruction, 8_000);
  if (!instruction) return failure("Job instruction is invalid");
  const result =
    content.result === undefined ? null : boundedText(content.result, 16_000);
  const jobFailure =
    content.failure === undefined ? null : boundedText(content.failure, 16_000);
  if (
    (content.result !== undefined && !result) ||
    (content.failure !== undefined && !jobFailure)
  ) {
    return failure("Job outcome detail is invalid");
  }

  const checkpointSequenceRaw = optionalValue("checkpoint-seq");
  const checkpointSequence =
    checkpointSequenceRaw === null ? 0 : Number(checkpointSequenceRaw);
  const checkpointEvent = optionalValue("checkpoint-event");
  let checkpoint: TaskRunCheckpoint | null = null;
  if (
    content.checkpoint !== undefined ||
    checkpointSequence > 0 ||
    checkpointEvent !== null
  ) {
    if (
      !isRecord(content.checkpoint) ||
      Object.keys(content.checkpoint).some(
        (key) => !["summary", "resumeToken", "progress"].includes(key),
      ) ||
      !Number.isSafeInteger(checkpointSequence) ||
      checkpointSequence < 1 ||
      checkpointEvent === null ||
      !HEX_64.test(checkpointEvent)
    ) {
      return failure("Job checkpoint evidence is invalid");
    }
    const summary = boundedText(content.checkpoint.summary, 4_000);
    const rawProgress = content.checkpoint.progress ?? null;
    const resumeToken = content.checkpoint.resumeToken ?? null;
    if (
      !summary ||
      (rawProgress !== null &&
        (typeof rawProgress !== "number" ||
          !Number.isSafeInteger(rawProgress) ||
          rawProgress < 0 ||
          rawProgress > 100)) ||
      (resumeToken !== null && !boundedText(resumeToken, 4_000))
    ) {
      return failure("Job checkpoint body is invalid");
    }
    checkpoint = {
      sequence: checkpointSequence,
      summary,
      progress: typeof rawProgress === "number" ? rawProgress : null,
      eventId: checkpointEvent,
    };
  }

  const rawArtifacts = content.artifacts ?? [];
  if (!Array.isArray(rawArtifacts)) return failure("Job artifacts are invalid");
  const artifacts = rawArtifacts.map(parseArtifact);
  if (artifacts.some((artifact) => artifact === null)) {
    return failure("Job artifact is invalid");
  }
  const outcomeEventId = optionalValue("outcome-event");
  if (outcomeEventId !== null && !HEX_64.test(outcomeEventId)) {
    return failure("Job outcome receipt is invalid");
  }
  if (
    required.runStatus === "delivered" &&
    (outcomeEventId === null || artifacts.length === 0)
  ) {
    return failure("Delivered Job requires accepted artifact evidence");
  }
  if (required.runStatus !== "delivered" && artifacts.length > 0) {
    return failure("Only a delivered Job may expose artifact evidence");
  }

  return {
    ok: true,
    value: {
      eventId: event.id,
      jobId: required.jobId.toLowerCase(),
      employeePubkey: required.employee.toLowerCase(),
      originatorPubkey: required.originator.toLowerCase(),
      filedByPubkey: required.filedBy.toLowerCase(),
      taskId: required.taskId,
      channelId: required.channelId,
      threadId: required.threadId,
      runStatus: required.runStatus as TaskRunStatus,
      attempts,
      leaseHolderPubkey: leaseHolder?.toLowerCase() ?? null,
      leaseExpiresAt,
      instruction,
      result,
      failure: jobFailure,
      checkpoint,
      artifacts: artifacts as TaskArtifact[],
      outcomeEventId,
      createdAt: event.created_at,
    },
  };
}

function collapseNip33Heads(events: readonly RelayEvent[]): RelayEvent[] {
  const coordinates = new Map<string, RelayEvent>();
  for (const event of events) {
    const coordinate = singleTag(event, "d");
    if (!coordinate) continue;
    const current = coordinates.get(coordinate);
    if (
      !current ||
      event.created_at > current.created_at ||
      (event.created_at === current.created_at && event.id < current.id)
    ) {
      coordinates.set(coordinate, event);
    }
  }
  return [...coordinates.values()];
}

function isNewerRun(left: TaskRunHead, right: TaskRunHead): boolean {
  return (
    left.createdAt > right.createdAt ||
    (left.createdAt === right.createdAt && left.eventId < right.eventId)
  );
}

/** Collapse NIP-33 coordinates and choose the newest valid task-bound run. */
export function collapseAndSelectCurrentTaskRun(
  events: readonly RelayEvent[],
  context: TaskRunContext,
): TaskRunHead | null {
  return (
    collapseNip33Heads(events)
      .map((event) => parseTaskRunHead(event, context))
      .filter((parsed): parsed is { ok: true; value: TaskRunHead } => parsed.ok)
      .map((parsed) => parsed.value)
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt ||
          left.eventId.localeCompare(right.eventId),
      )[0] ?? null
  );
}

/**
 * Collapse one bounded Job-head read for all task contexts in one pass.
 *
 * NIP-33 coordinates are collapsed before context validation, matching the
 * single-context helper above. Each surviving head is then signature-checked
 * at most once, instead of once per task in the global read.
 */
export function collapseAndSelectCurrentTaskRuns(
  events: readonly RelayEvent[],
  contexts: readonly TaskRunContext[],
): ReadonlyMap<string, TaskRunHead | null> {
  const contextByKey = new Map(
    contexts.map((context) => [
      `${context.taskId}\u0000${context.channelId}\u0000${context.threadId}`,
      context,
    ]),
  );
  const selected = new Map<string, TaskRunHead>();

  for (const event of collapseNip33Heads(events)) {
    const taskId = singleTag(event, "task");
    const channelId = singleTag(event, "h");
    const threadId = singleTag(event, "e");
    if (!taskId || !channelId || !threadId) continue;
    const context = contextByKey.get(
      `${taskId}\u0000${channelId}\u0000${threadId}`,
    );
    if (!context) continue;
    const parsed = parseTaskRunHead(event, context);
    if (!parsed.ok) continue;
    const current = selected.get(context.taskId);
    if (!current || isNewerRun(parsed.value, current)) {
      selected.set(context.taskId, parsed.value);
    }
  }

  return new Map(
    contexts.map((context) => [
      context.taskId,
      selected.get(context.taskId) ?? null,
    ]),
  );
}
