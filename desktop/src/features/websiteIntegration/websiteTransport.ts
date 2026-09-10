/**
 * Website Manager action transport.
 *
 * Owner decisions are reserved signed Block actions (`website.approve` /
 * `website.request-changes`) against the coordinator's pinned review card, so
 * the existing Blocks validation and receipt pipeline stays the only decision
 * path. `beginWork` is the ordinary kind-40027 command.
 *
 * Confirmation is canonical: the head store must reflect the decision (or the
 * started status) or a matching receipt must arrive. A lost receipt never
 * leaves the UI failed when the head already confirms the transition.
 */

import {
  canonicalBlockJson,
  submitBlockAction,
} from "@/features/blocks/blockActions";
import { parseBlockInstance } from "@/features/blocks/blockTags";
import { relayClient } from "@/shared/api/relayClient";
import { getEventById, signRelayEvent } from "@/shared/api/tauri";
import { KIND_WEBSITE_ACTION } from "@/shared/constants/kinds";

import type {
  WebsiteDecisionReceipt,
  WebsiteDecisionRequest,
} from "@/features/website/types";

import { websiteHeadsStore, type WebsiteHead } from "./websiteHeads";

const LOST_RECEIPT_GRACE_MS = 4_000;
const WEBSITE_ACTION_SCHEMA = "colony.website-action/v1";
const WEBSITE_JOB_BLOCK_HANDLE = "website-job";
const WEBSITE_APPROVE_ACTION_ID = "website.approve";
const WEBSITE_REQUEST_CHANGES_ACTION_ID = "website.request-changes";
const HEX_64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type WebsiteInstanceRef = {
  instanceEventId: string;
  instanceId: string;
  manifestId: string;
  processorPubkey: string;
};

export type WebsiteDecisionSubmit = {
  /** Community the head belongs to; scopes the store lookup. */
  communityId: string;
  head: WebsiteHead;
  request: WebsiteDecisionRequest;
  /** Parsed from the pinned review card when the caller already has it. */
  instance?: WebsiteInstanceRef | null;
  signal?: AbortSignal;
};

function hexToUuid(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Deterministic idempotency key over the decision identity fields. A retry
 * reuses it, so the Block action lock and the relay's derived id agree.
 */
export async function deriveWebsiteIdempotencyKey(
  parts: readonly (string | number)[],
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(parts)),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hexToUuid(hex);
}

/**
 * Build a transport ref from the review card's own tags. Returns null when the
 * message is not the pinned card or does not declare the job block.
 */
export function websiteInstanceRefFromMessage(input: {
  head: WebsiteHead;
  messageId: string;
  tags: readonly string[][] | undefined;
}): WebsiteInstanceRef | null {
  const { head, messageId, tags } = input;
  if (messageId.toLowerCase() !== head.instanceEventId) return null;
  const parsed = parseBlockInstance(tags ? tags.map((tag) => [...tag]) : []);
  if (!parsed.ok) return null;
  if (parsed.value.handle !== WEBSITE_JOB_BLOCK_HANDLE) return null;
  if (parsed.value.manifestId !== head.manifestEventId) return null;
  return {
    instanceEventId: head.instanceEventId,
    instanceId: parsed.value.instanceId,
    manifestId: parsed.value.manifestId,
    processorPubkey: parsed.value.processorPubkey ?? head.coordinatorPubkey,
  };
}

const instanceRefCache = new Map<string, Promise<WebsiteInstanceRef | null>>();

/**
 * Resolve the pinned review card's Block instance identity. The card declares
 * the `website-job` handle and the manifest id carried by the head; both are
 * required before an action is addressed to it.
 */
export function resolveWebsiteInstanceRef(
  head: WebsiteHead,
): Promise<WebsiteInstanceRef | null> {
  const cached = instanceRefCache.get(head.instanceEventId);
  if (cached) return cached;
  const request = (async (): Promise<WebsiteInstanceRef | null> => {
    let event: Awaited<ReturnType<typeof getEventById>> | null = null;
    try {
      event = await getEventById(head.instanceEventId);
    } catch {
      return null;
    }
    if (!event || !HEX_64.test(event.id)) return null;
    if (event.pubkey.toLowerCase() !== head.coordinatorPubkey) return null;
    const parsed = parseBlockInstance(event.tags);
    if (!parsed.ok) return null;
    if (parsed.value.handle !== WEBSITE_JOB_BLOCK_HANDLE) return null;
    if (parsed.value.manifestId !== head.manifestEventId) return null;
    return {
      instanceEventId: head.instanceEventId,
      instanceId: parsed.value.instanceId,
      manifestId: parsed.value.manifestId,
      processorPubkey: parsed.value.processorPubkey ?? head.coordinatorPubkey,
    };
  })().catch(() => null);
  instanceRefCache.set(head.instanceEventId, request);
  return request;
}

export function resetWebsiteInstanceRefCache(): void {
  instanceRefCache.clear();
}

function requestScopeMatchesHead(
  head: WebsiteHead,
  request: WebsiteDecisionRequest,
): boolean {
  const headRevision = head.record.revisions.find(
    (revision) => revision.revision === head.record.currentRevision,
  );
  return (
    request.jobId === head.jobId &&
    request.taskId === head.taskId &&
    request.channel === head.channelId &&
    request.revision === head.record.currentRevision &&
    Boolean(headRevision) &&
    request.manifestSha256 === headRevision?.preview.sha256 &&
    request.actor === head.ownerPubkey
  );
}

function decisionRecorded(
  head: WebsiteHead,
  request: WebsiteDecisionRequest,
): boolean {
  return head.record.decisions.some(
    (decision) =>
      decision.kind === request.kind &&
      decision.revision === request.revision &&
      decision.manifestSha256 === request.manifestSha256 &&
      decision.actor === request.actor &&
      (decision.note ?? undefined) === (request.note ?? undefined),
  );
}

function waitForHead(
  input: { communityId: string; head: WebsiteHead },
  predicate: (candidate: WebsiteHead) => boolean,
  timeoutMs: number,
): Promise<WebsiteHead | null> {
  const { communityId, head } = input;
  const current = websiteHeadsStore.headForThread(
    communityId,
    head.channelId,
    head.threadRoot,
  );
  if (current && predicate(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: WebsiteHead | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const check = () => {
      const candidate = websiteHeadsStore.headForThread(
        communityId,
        head.channelId,
        head.threadRoot,
      );
      if (candidate && predicate(candidate)) finish(candidate);
    };
    const unsubscribe = websiteHeadsStore.subscribe(check);
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    check();
  });
}

function messageForError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "The website action could not be sent.";
}

/**
 * Publish an owner approve / request-changes Block action pinned to the exact
 * head revision and manifest. The Block action id, processor, instance, and
 * manifest come from the verified head plus the review card, never from input.
 */
export async function submitWebsiteDecision(
  input: WebsiteDecisionSubmit,
): Promise<WebsiteDecisionReceipt> {
  const { communityId, head, request } = input;
  if (!requestScopeMatchesHead(head, request)) {
    throw new Error(
      "This decision does not match the current website version.",
    );
  }
  const instance = input.instance ?? (await resolveWebsiteInstanceRef(head));
  if (!instance) {
    throw new Error(
      "The pinned review card could not be verified, so the decision was not sent.",
    );
  }
  if (input.signal?.aborted) {
    throw new DOMException("The decision was aborted", "AbortError");
  }
  const actionId =
    request.kind === "approve"
      ? WEBSITE_APPROVE_ACTION_ID
      : WEBSITE_REQUEST_CHANGES_ACTION_ID;
  const idempotencyKey = await deriveWebsiteIdempotencyKey([
    "colony.website.block-action/v1",
    head.jobId,
    request.revision,
    request.manifestSha256,
    request.kind,
    request.actor,
  ]);
  const data = {
    schema: WEBSITE_ACTION_SCHEMA,
    jobId: head.jobId,
    taskId: head.taskId,
    generation: head.generation,
    revision: request.revision,
    manifestSha256: request.manifestSha256,
    ...(request.note ? { note: request.note } : {}),
  };
  try {
    const actionEvent = await submitBlockAction({
      actionId,
      channelId: head.channelId,
      data,
      instanceEventId: head.instanceEventId,
      manifestId: instance.manifestId,
      instanceId: instance.instanceId,
      processorPubkey: instance.processorPubkey,
      idempotencyKey,
    });
    return { eventId: actionEvent.id };
  } catch (error) {
    const confirmed = await waitForHead(
      { communityId, head },
      (candidate) => decisionRecorded(candidate, request),
      LOST_RECEIPT_GRACE_MS,
    );
    if (confirmed) {
      return { eventId: confirmed.eventId };
    }
    throw new Error(messageForError(error));
  }
}

/**
 * Publish the owner/coordinator `beginWork` command. The generation comes from
 * the observed head so the relay's compare-and-set can refuse a stale start.
 */
export async function submitWebsiteBeginWork(
  communityId: string,
  head: WebsiteHead,
): Promise<{ eventId: string }> {
  if (head.record.status !== "draft") {
    throw new Error("This website job has already started.");
  }
  const requestId = await deriveWebsiteIdempotencyKey([
    "colony.website.begin-work/v1",
    head.jobId,
    head.generation,
    head.ownerPubkey,
  ]);
  if (!UUID.test(requestId)) {
    throw new Error("The start request identity is invalid.");
  }
  const event = await signRelayEvent({
    kind: KIND_WEBSITE_ACTION,
    content: canonicalBlockJson({
      op: "beginWork",
      schema: WEBSITE_ACTION_SCHEMA,
    }),
    tags: [
      ["h", head.channelId],
      ["task", head.taskId],
      ["thread", head.threadRoot],
      ["request", requestId],
      ["generation", String(head.generation)],
      ["instance", head.instanceEventId],
      ["manifest", head.manifestEventId],
    ],
  });
  try {
    await relayClient.publishEvent(
      event,
      "Timed out while starting the website redesign.",
      "Failed to start the website redesign.",
    );
    return { eventId: event.id };
  } catch (error) {
    const confirmed = await waitForHead(
      { communityId, head },
      (candidate) => candidate.record.status !== "draft",
      LOST_RECEIPT_GRACE_MS,
    );
    if (confirmed) return { eventId: confirmed.eventId };
    throw new Error(messageForError(error));
  }
}
