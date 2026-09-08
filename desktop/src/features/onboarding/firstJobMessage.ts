import { npubEncode } from "nostr-tools/nip19";
import type { FirstJobScope, FirstJobTeam } from "./firstJobStart";

/** Bind every editable byte and actor identity without putting metadata in the task title. */
export async function firstJobDispatchBinding(
  scope: FirstJobScope,
  content: string,
  team: FirstJobTeam,
  revision: number,
  nonce: string,
): Promise<string> {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      nonce,
    )
  )
    throw new Error("The saved start identity could not be verified.");
  const canonical = JSON.stringify([
    "colony-first-job-v1",
    scope.ownerPubkey,
    scope.relayUrl,
    scope.channelId,
    scope.threadRootId,
    scope.requestId,
    nonce,
    content,
    team.scoutPubkey,
    team.workerPubkey,
    ...(revision > 0 ? ["refused-attempt-revision", revision] : []),
  ]);
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Ordinary thread instruction; only Scout is pinged, the worker is a reference. */
export function firstJobInstruction(
  content: string,
  team: FirstJobTeam,
): string {
  return `${content}\n\nCoordinate this job in this thread. Ask nostr:${npubEncode(team.workerPubkey)} to do the work, review the result, and bring it back here for my review.`;
}
