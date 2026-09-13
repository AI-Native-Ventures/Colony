/**
 * Request the native evidence capability for every live worker while a
 * verified Website job is active.
 *
 * The renderer supplies only coordinates copied from the relay-verified head.
 * `browser:workers` is the existing native roster view, and each grant request
 * is independently checked by EvidenceAuthority against the signed task,
 * Website head, owner persona, and current worker generation. An unassigned
 * live worker is therefore skipped by the native authority rather than being
 * trusted because it appeared in the roster.
 */

import { electronDesktop } from "@/shared/api/electronNativeBridge";
import type { WebsiteJobStatus } from "@/features/website/types";

import type { WebsiteHead } from "./websiteHeads";

const ACTIVE_STATUSES: ReadonlySet<WebsiteJobStatus> = new Set([
  "working",
  "readyForReview",
  "approved",
  "changesRequested",
]);
const PUBKEY = /^[a-f0-9]{64}$/i;

type LiveWorker = { pubkey?: unknown };

const inFlight = new Map<string, Promise<void>>();

function requestKey(input: {
  communityId: string;
  relayUrl: string;
  head: WebsiteHead;
  workerPubkey: string;
}): string {
  return [
    input.communityId,
    input.relayUrl,
    input.head.eventId,
    input.head.generation,
    input.workerPubkey,
  ].join("\u0000");
}

/**
 * Ask the native shell to mint each currently live worker's signed grant.
 * Failures are intentionally isolated per worker: the native authority may
 * reject a roster row that is not assigned to this job, while another assigned
 * worker can still receive its capability.
 */
export async function ensureWebsiteEvidenceGrants(input: {
  communityId: string;
  relayUrl: string;
  head: WebsiteHead;
}): Promise<void> {
  if (!ACTIVE_STATUSES.has(input.head.record.status)) return;
  const api = electronDesktop();
  if (!api) return;

  const rows = await api.request<readonly LiveWorker[]>("browser:workers");
  if (!Array.isArray(rows)) return;
  const workers = [
    ...new Set(
      rows.flatMap((row) => {
        const pubkey = typeof row?.pubkey === "string" ? row.pubkey.toLowerCase() : "";
        return PUBKEY.test(pubkey) ? [pubkey] : [];
      }),
    ),
  ];
  const requests = workers.map((workerPubkey) => {
    const key = requestKey({ ...input, workerPubkey });
    const previous = inFlight.get(key);
    if (previous) return previous;
    const request = api
      .request("browser:evidence-grant", {
        scope: {
          communityId: input.communityId,
          relayUrl: input.relayUrl,
          ownerPubkey: input.head.ownerPubkey,
          jobId: input.head.jobId,
          taskId: input.head.taskId,
          channelId: input.head.channelId,
          workerPubkey,
          threadRoot: input.head.threadRoot,
        },
      })
      .then(() => {})
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  });
  await Promise.allSettled(requests);
}
