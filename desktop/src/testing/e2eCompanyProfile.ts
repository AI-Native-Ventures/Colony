import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import {
  canonicalCompanyJson,
  parseCompanyHead,
  type CompanyProfile,
} from "@/features/company/contracts";
import type { RelayEvent } from "@/shared/api/types";

/** Byte-for-byte the encoding the relay signs company content as. */
export function canonicalCompanyMockJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCompanyMockJson).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>).sort();
  return `{${entries
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalCompanyMockJson(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(",")}}`;
}

/** The configured default for existing task fixtures. */
export function mockCompanyRecord(config: {
  tradingName?: string;
  costCentreId: string;
}) {
  return {
    schema: "colony.company/v1",
    tradingName: config.tradingName ?? "Horizon Labs",
    legalName: null,
    website: null,
    summary: "Software for South African businesses.",
    businessType: "agency",
    services: [],
    customerSegments: [],
    costCentres: [
      {
        id: config.costCentreId,
        name: "Company coordination",
        kind: "internal",
        serviceId: null,
      },
    ],
    sourceReportEventId: null,
    createdAt: 1_780_000_000,
    updatedAt: 1_780_000_000,
  };
}

/** Synthetic relay bootstrap; no task, worker or execution is implied. */
export type CommunityProfileHeadSeed = {
  tradingName?: string;
  summary?: string;
  businessType?: string;
  costCentreId?: string;
  createdAt?: number;
  updatedAt?: number;
  signerSecretHex?: string;
};

/** The same empty business context created by the relay's profile backfill. */
export function mockCommunityProfileHeadRecord(
  seed: CommunityProfileHeadSeed,
): CompanyProfile {
  return {
    schema: "colony.company/v1",
    tradingName: seed.tradingName ?? "Horizon Labs",
    legalName: null,
    website: null,
    summary: seed.summary ?? "",
    businessType: seed.businessType ?? "unspecified",
    services: [],
    customerSegments: [],
    costCentres: [
      {
        id: seed.costCentreId ?? "general",
        name: "General",
        kind: "internal",
        serviceId: null,
      },
    ],
    sourceReportEventId: null,
    createdAt: seed.createdAt ?? 1_780_000_000,
    updatedAt: seed.updatedAt ?? 1_780_000_000,
  };
}

const normalizeRelay = (value: string) => value.trim().replace(/\/+$/, "");
const isHex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const namespace = hexToBytes("1e9f4d2a7c3b4e8a9d5f6210a4c78351");

// Mirror buzz_core::company_roster::step_idempotency_key for this command.
async function profileIdempotency(requestId: string): Promise<string> {
  const name = new TextEncoder().encode(
    `${requestId}:community-profile-update`,
  );
  const bytes = new Uint8Array(namespace.length + name.length);
  bytes.set(namespace);
  bytes.set(name, namespace.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)).slice(
    0,
    16,
  );
  hash[6] = (hash[6] & 15) | 0x50;
  hash[8] = (hash[8] & 63) | 0x80;
  const hex = bytesToHex(hash);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type SigningContext = {
  identity: { pubkey: string; privateKey: string } | undefined;
  relayUrl: string;
  relayPubkey: string;
};
type UpdateInput = {
  profile: string;
  expectedHeadEventId: string;
  relayPubkey: string;
  requestId: string;
  expectedOwnerPubkey?: string;
  expectedRelayUrl?: string;
};

function validateProfile(record: CompanyProfile, secret: Uint8Array): void {
  const candidate = finalizeEvent(
    {
      kind: 30179,
      created_at: 1,
      tags: [["d", "profile"]],
      content: canonicalCompanyJson(record),
    },
    secret,
  );
  if (
    !parseCompanyHead(candidate, candidate.pubkey).ok ||
    !record.tradingName.trim() ||
    Array.from(record.tradingName).length > 200 ||
    Array.from(record.summary).length > 4000
  )
    throw new Error("That is not a valid community profile.");
}

/** Owner signature, exact command scope and native-shaped canonical envelope. */
export async function signMockCommunityProfileUpdate(
  input: UpdateInput,
  context: SigningContext,
): Promise<string> {
  const identity = context.identity;
  if (
    !identity ||
    getPublicKey(hexToBytes(identity.privateKey)) !== identity.pubkey
  )
    throw new Error(
      "A real synthetic signing identity is required for this profile update.",
    );
  const scoped =
    input.expectedOwnerPubkey !== undefined ||
    input.expectedRelayUrl !== undefined;
  if (
    scoped &&
    (!input.expectedOwnerPubkey ||
      !input.expectedRelayUrl ||
      input.expectedOwnerPubkey !== identity.pubkey ||
      normalizeRelay(input.expectedRelayUrl) !==
        normalizeRelay(context.relayUrl))
  )
    throw new Error(
      "The account or community changed before saving business details.",
    );
  if (
    !isHex(input.expectedHeadEventId) ||
    !isHex(input.relayPubkey) ||
    input.relayPubkey !== context.relayPubkey ||
    !isUuid(input.requestId)
  )
    throw new Error("The business update scope is invalid.");
  const profile = JSON.parse(input.profile) as CompanyProfile;
  validateProfile(profile, hexToBytes(identity.privateKey));
  const target = `30179:${input.relayPubkey}:profile`;
  const idempotencyKey = await profileIdempotency(input.requestId);
  const action = finalizeEvent(
    {
      kind: 40013,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", input.relayPubkey],
        ["a", target],
        ["company-action", "1", "update", input.requestId, idempotencyKey],
      ],
      content: canonicalCompanyJson({
        schema: "colony.company-action/v1",
        operation: "update",
        requestId: input.requestId,
        idempotencyKey,
        target,
        expectedHead: input.expectedHeadEventId,
        expectedReferences: [],
        payload: { kind: "company", record: profile },
      }),
    },
    hexToBytes(identity.privateKey),
  );
  return JSON.stringify(action);
}

/** Apply only verified profile actions with CAS; all Task routing remains in the bridge. */
export function brokerMockCommunityProfileAction(
  event: RelayEvent,
  context: {
    ownerPubkey: string;
    relaySecret: Uint8Array;
    heads: RelayEvent[];
    actions: RelayEvent[];
    receipts: RelayEvent[];
  },
): boolean | null {
  const target = event.tags.find((tag) => tag[0] === "a")?.[1];
  if (!target?.startsWith("30179:")) return null;
  const relay = getPublicKey(context.relaySecret);
  const tuple = event.tags.find((tag) => tag[0] === "company-action");
  let body: {
    schema: string;
    operation: string;
    requestId: string;
    idempotencyKey: string;
    target: string;
    expectedHead: string;
    expectedReferences: unknown[];
    payload: { kind: string; record: CompanyProfile };
  };
  try {
    body = JSON.parse(event.content);
    const fresh = {
      id: event.id,
      pubkey: event.pubkey,
      sig: event.sig,
      kind: event.kind,
      created_at: event.created_at,
      content: event.content,
      tags: event.tags,
    };
    if (
      !verifyEvent(fresh) ||
      event.kind !== 40013 ||
      event.pubkey !== context.ownerPubkey ||
      target !== `30179:${relay}:profile` ||
      canonicalCompanyJson(event.tags) !==
        canonicalCompanyJson([
          ["p", relay],
          ["a", target],
          [
            "company-action",
            "1",
            "update",
            body.requestId,
            body.idempotencyKey,
          ],
        ]) ||
      tuple?.[3] !== body.requestId ||
      tuple?.[4] !== body.idempotencyKey ||
      !isUuid(body.requestId) ||
      !isUuid(body.idempotencyKey) ||
      canonicalCompanyJson(body) !== event.content ||
      body.schema !== "colony.company-action/v1" ||
      body.operation !== "update" ||
      body.target !== target ||
      !isHex(body.expectedHead) ||
      !Array.isArray(body.expectedReferences) ||
      body.expectedReferences.length ||
      body.payload?.kind !== "company"
    )
      return false;
    validateProfile(body.payload.record, context.relaySecret);
  } catch {
    return false;
  }
  if (
    context.receipts.some((receipt) =>
      receipt.tags.some((tag) => tag[0] === "e" && tag[1] === event.id),
    )
  )
    return true;
  const previousAction = context.actions.find(
    (action) =>
      action.pubkey === event.pubkey &&
      action.tags.some(
        (tag) => tag[0] === "company-action" && tag[4] === body.idempotencyKey,
      ),
  );
  if (previousAction && previousAction.content !== event.content) return false;
  if (!context.actions.some((action) => action.id === event.id))
    context.actions.push(event);
  const heads = context.heads.filter(
    (head) => head.kind === 30179 && head.pubkey === relay,
  );
  const current = heads.sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  )[0];
  const profile = body.payload.record;
  let outcome = current?.id === body.expectedHead ? "applied" : "conflict";
  if (previousAction && previousAction.id !== event.id) outcome = "conflict";
  let headEventId: string | null = null;
  if (outcome === "applied" && current) {
    const previous = JSON.parse(current.content) as CompanyProfile;
    if (
      profile.createdAt !== previous.createdAt ||
      profile.updatedAt < previous.updatedAt
    )
      outcome = "rejected";
    else {
      const head = finalizeEvent(
        {
          kind: 30179,
          created_at: Math.max(
            Math.floor(Date.now() / 1000),
            current.created_at + 1,
          ),
          tags: [["d", "profile"]],
          content: canonicalCompanyJson(profile),
        },
        context.relaySecret,
      );
      context.heads.push(head);
      headEventId = head.id;
    }
  }
  context.receipts.push(
    finalizeEvent(
      {
        kind: 40014,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["p", event.pubkey],
          ["e", event.id, "", "company-action"],
          ["a", target],
          [
            "company-receipt",
            "1",
            body.requestId,
            body.idempotencyKey,
            outcome,
          ],
        ],
        content: canonicalCompanyJson({
          schema: "colony.company-receipt/v1",
          headEventId,
        }),
      },
      context.relaySecret,
    ),
  );
  return true;
}

/** Relay-signed source head, including the explicit alternate-relay fixture. */
export function seedMockCommunityProfileHead(
  seed: CommunityProfileHeadSeed,
  defaultSecret: Uint8Array,
): RelayEvent {
  return finalizeEvent(
    {
      kind: 30179,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", "profile"]],
      content: canonicalCompanyMockJson(mockCommunityProfileHeadRecord(seed)),
    },
    seed.signerSecretHex ? hexToBytes(seed.signerSecretHex) : defaultSecret,
  );
}
