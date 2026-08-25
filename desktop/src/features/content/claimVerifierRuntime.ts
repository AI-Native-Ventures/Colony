/**
 * The verifier's dependencies, wired to this machine.
 *
 * Page sources are fetched through the native guarded fetcher when the app
 * runs under Tauri: the same SSRF guard, pinned addresses and byte cap a
 * company scan gets, because a claim URL is agent-authored text and must be
 * treated exactly like agent-authored scan input. In the plain browser
 * (dev server, e2e mock) there is no native shell, so it falls back to
 * `window.fetch`, CORS included.
 *
 * Owner events are read back from the relay by id; the kinds list covers the
 * message surfaces an owner's signed assertion can live on.
 */

import { invoke, isTauri } from "@/shared/api/nativeBridge";
import { relayClient } from "@/shared/api/relayClient";
import { normalizePubkey } from "@/shared/lib/pubkey";
import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
} from "@/shared/constants/kinds";

import type { VerifierDependencies } from "./claimVerifier";

type ClaimSourcePageOutcome =
  | { body: string; status: "success" }
  | { message: string; status: "invalid" | "failed" | "timeout" };

async function fetchPageHtml(url: string): Promise<string> {
  if (isTauri()) {
    const outcome = await invoke<ClaimSourcePageOutcome>(
      "fetch_claim_source_page",
      { url },
    );
    if (outcome.status === "success") {
      return outcome.body;
    }
    throw new Error(outcome.message);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

async function fetchEventById(eventId: string) {
  const [event] = await relayClient.fetchEvents({
    ids: [eventId],
    kinds: [KIND_STREAM_MESSAGE, KIND_STREAM_MESSAGE_V2],
    limit: 1,
  });
  return event ?? null;
}

/**
 * Verifier dependencies bound to the workspace's owner pubkey set.
 *
 * The set comes from the community membership snapshot (`communityOwners.ts`)
 * and may be empty while loading or for relays that publish none; the
 * verifier fails closed against an empty set, so nothing is owner-signed
 * before ownership is actually known.
 */
export function claimVerifierDependencies(
  ownerPubkeys: ReadonlySet<string>,
): VerifierDependencies {
  return {
    fetchEventById,
    fetchPageHtml,
    isOwnerPubkey: (pubkey) => ownerPubkeys.has(normalizePubkey(pubkey)),
  };
}
