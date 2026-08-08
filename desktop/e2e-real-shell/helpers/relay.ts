// Direct relay assertions. The point of the messaging flow is that the app's
// socket wrote to the REAL relay, so verify on the relay itself, not just in
// the UI.
import { createHash } from "node:crypto";

import { RELAY_HTTP_URL } from "./env";

export function uuid5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1");
  hash.update(ns);
  hash.update(Buffer.from(name, "utf8"));
  const digest = hash.digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The seed script namespaces channels under the DNS namespace with these
// slugs; the seeded community uses the same ids the app's "starter channels"
// expect.
export const CHANNEL_SLUGS: Record<string, string> = {
  general: "buzz.channel.general",
  random: "buzz.channel.random",
  engineering: "buzz.channel.engineering",
  agents: "buzz.channel.agents",
  watercooler: "buzz.channel.watercooler",
  announcements: "buzz.channel.announcements",
};

export type RelayEvent = {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
  created_at: number;
};

type QueryFilter = {
  kinds?: number[];
  authors?: string[];
  limit?: number;
};

// Nostr REQ over the relay's generic HTTP bridge (POST /query).
// The isolated relay runs with BUZZ_REQUIRE_AUTH_TOKEN=false, so the
// bridge's dev-mode X-Pubkey header authenticates the query (the identity
// under test); NIP-98 signing would otherwise be needed for every poll.
export async function queryRelay(
  filters: QueryFilter[],
  authPubkey = "953d3363262e86b770419834c53d2446409db6d918a57f8f339d495d54ab001f",
): Promise<RelayEvent[]> {
  const response = await fetch(`${RELAY_HTTP_URL}/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pubkey": authPubkey,
    },
    body: JSON.stringify(filters),
  });
  if (!response.ok) {
    throw new Error(
      `relay /query failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as RelayEvent[];
}

export async function waitForRelayMessage(
  pubkey: string,
  contentMarker: string,
  timeoutMs = 60_000,
): Promise<RelayEvent> {
  const deadline = Date.now() + timeoutMs;
  let last: RelayEvent[] = [];
  while (Date.now() < deadline) {
    last = await queryRelay(
      [
        { kinds: [9], authors: [pubkey], limit: 50 },
        { kinds: [40002], authors: [pubkey], limit: 50 },
      ],
      pubkey,
    );
    const hit = last.find((event) => event.content.includes(contentMarker));
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `relay never received message containing ${JSON.stringify(contentMarker)}; last ${last.length} events`,
  );
}
