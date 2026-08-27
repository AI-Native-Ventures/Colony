import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { canonicalBlockJson } from "@/features/blocks/blockActions";
import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_BLOCK_CATALOG_ENTRY,
  KIND_STREAM_MESSAGE,
} from "@/shared/constants/kinds";

import { companyRepository } from "./companyRepository";
import type { CompanyProfile, Initiative } from "./contracts";

/**
 * Putting the proposed work in front of the owner.
 *
 * Approving a company creates initiatives as relay-authored records. A record
 * nobody can see is not a proposal, so one Initiative card is posted per
 * proposed initiative into the conversation the approval happened in. This is
 * the whole surface: no list, no page, no dashboard.
 *
 * Posting is idempotent by instance identity. Each card's instance ID is
 * derived from its initiative, and the channel is checked for that ID before
 * anything is sent, so approving twice does not paper the conversation with
 * duplicate cards.
 */

const CARD_HANDLE = "initiative";
const CHANNEL_SCAN_LIMIT = 300;

/**
 * A UUID derived from a name rather than generated.
 *
 * Version 8 is the "custom" version, which is exactly what this is: the digest
 * of a fixed namespace and the initiative ID, laid out as a UUID so it fits the
 * Block instance envelope. The point is only that the same initiative always
 * produces the same instance ID.
 */
export function derivedInstanceId(name: string): string {
  const digest = bytesToHex(
    sha256(new TextEncoder().encode(`colony.initiative-card:${name}`)),
  );
  const version = "8";
  // 0b10xx: the RFC 4122 variant nibble.
  const variant = "89ab"[Number.parseInt(digest[16] as string, 16) & 0b11];
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `${version}${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function prettyPersona(personaId: string): string {
  const slug = personaId.split(":").pop() ?? personaId;
  const words = slug.replace(/-/g, " ").trim();
  return words === ""
    ? personaId
    : words.charAt(0).toUpperCase() + words.slice(1);
}

function costCentreName(company: CompanyProfile, costCentreId: string): string {
  return (
    company.costCentres.find((centre) => centre.id === costCentreId)?.name ??
    costCentreId
  );
}

export function initiativeCardData(
  initiative: Initiative,
  company: CompanyProfile,
): Record<string, unknown> {
  return {
    initiative_id: initiative.id,
    title: initiative.title,
    summary: initiative.summary,
    status: initiative.status,
    owner: prettyPersona(initiative.ownerPersonaId),
    cost_centre: costCentreName(company, initiative.costCentreId),
    commercial_purpose: initiative.commercialPurpose,
  };
}

/** Instance IDs already carried by a Block message in this channel. */
export function postedInstanceIds(
  events: readonly RelayEvent[],
): ReadonlySet<string> {
  const posted = new Set<string>();
  for (const event of events) {
    for (const tag of event.tags) {
      if (tag[0] === "block" && tag.length === 5 && tag[2] === CARD_HANDLE) {
        const instanceId = tag[4];
        if (instanceId) posted.add(instanceId);
      }
    }
  }
  return posted;
}

export type PostInitiativeCardsInput = {
  channelId: string;
};

export type PostInitiativeCardsDependencies = {
  relaySelf: () => Promise<string | null>;
  loadCompany: () => ReturnType<typeof companyRepository.getActiveCompany>;
  loadInitiatives: () => ReturnType<typeof companyRepository.listInitiatives>;
  fetchChannel: (channelId: string) => Promise<RelayEvent[]>;
  fetchCatalog: (
    handle: string,
    relaySelfPubkey: string,
  ) => Promise<RelayEvent | null>;
  sign: typeof signRelayEvent;
  publish: (event: RelayEvent) => Promise<RelayEvent>;
};

/** The manifest the relay currently serves for a Core Block handle. */
function activeManifestId(catalog: RelayEvent | null): string | null {
  if (!catalog) return null;
  try {
    const content = JSON.parse(catalog.content) as {
      active_manifest_id?: unknown;
      status?: unknown;
    };
    if (content.status !== "active") return null;
    const manifestId = content.active_manifest_id;
    return typeof manifestId === "string" && /^[0-9a-f]{64}$/.test(manifestId)
      ? manifestId
      : null;
  } catch {
    return null;
  }
}

export function createInitiativeCardPoster(
  dependencies: PostInitiativeCardsDependencies,
) {
  return async function post(
    input: PostInitiativeCardsInput,
  ): Promise<{ posted: string[]; skipped: string[] }> {
    const relaySelfPubkey = await dependencies.relaySelf();
    if (!relaySelfPubkey) return { posted: [], skipped: [] };

    const [company, initiatives] = await Promise.all([
      dependencies.loadCompany(),
      dependencies.loadInitiatives(),
    ]);
    if (!company.ok || !initiatives.ok) return { posted: [], skipped: [] };

    const proposed = initiatives.value.filter(
      (initiative) => initiative.status === "proposed",
    );
    if (proposed.length === 0) return { posted: [], skipped: [] };

    const manifestId = activeManifestId(
      await dependencies.fetchCatalog(CARD_HANDLE, relaySelfPubkey),
    );
    if (!manifestId) return { posted: [], skipped: [] };

    const alreadyPosted = postedInstanceIds(
      await dependencies.fetchChannel(input.channelId),
    );

    const posted: string[] = [];
    const skipped: string[] = [];
    for (const initiative of proposed) {
      const instanceId = derivedInstanceId(initiative.id);
      if (alreadyPosted.has(instanceId)) {
        skipped.push(initiative.id);
        continue;
      }
      const data = canonicalBlockJson(
        initiativeCardData(initiative, company.value),
      );
      const event = await dependencies.sign({
        kind: KIND_STREAM_MESSAGE,
        content: initiative.title,
        tags: [
          ["h", input.channelId],
          ["e", manifestId, "", "block"],
          ["block", "1", CARD_HANDLE, manifestId, instanceId],
          ["block-data", data],
          // The relay is the processor because the relay is what actually
          // applies these changes: it authors every company head and signs the
          // receipt for each one. No attention tag, so nothing waits on a Block
          // receipt that this flow never produces.
          ["block-processor", "1", relaySelfPubkey],
        ],
      });
      await dependencies.publish(event);
      posted.push(initiative.id);
    }
    return { posted, skipped };
  };
}

export const postInitiativeCards = createInitiativeCardPoster({
  relaySelf: getRelaySelf,
  loadCompany: () => companyRepository.getActiveCompany(),
  loadInitiatives: () => companyRepository.listInitiatives(),
  fetchChannel: (channelId) =>
    relayClient.fetchEvents({
      kinds: [KIND_STREAM_MESSAGE],
      "#h": [channelId],
      limit: CHANNEL_SCAN_LIMIT,
    }),
  fetchCatalog: (handle, relaySelfPubkey) =>
    relayClient.fetchFirstEvent({
      kinds: [KIND_BLOCK_CATALOG_ENTRY],
      authors: [relaySelfPubkey],
      "#d": [handle],
      limit: 1,
    }),
  sign: signRelayEvent,
  publish: (event) =>
    relayClient.publishEvent(
      event,
      "Timed out while posting the proposed work.",
      "The proposed work could not be posted.",
    ),
});
