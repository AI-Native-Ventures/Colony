export const DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD = 50_000_000n;

type CampaignBudgetFingerprintInput = {
  campaignId: string;
  industryId: string;
  verticalId: string;
  query: string;
  location: string;
  target: number;
  language: string;
  region: string | null;
  payerPubkey: string;
};

function hexBytes(value: string, field: string): Uint8Array {
  const normalized = value.replaceAll("-", "");
  if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`Invalid ${field}.`);
  }
  return Uint8Array.from(
    normalized.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, false);
  return bytes;
}

function textPart(value: string): Uint8Array[] {
  const encoded = new TextEncoder().encode(value);
  return [u32(encoded.length), encoded];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** Match buzz_core::discovery_workspace::campaign_budget_fingerprint. */
export async function campaignBudgetFingerprint(
  input: CampaignBudgetFingerprintInput,
): Promise<string> {
  if (!Number.isInteger(input.target) || input.target < 1 || input.target > 500) {
    throw new Error("Invalid Discovery lead target.");
  }
  const prefix = new TextEncoder().encode(
    "colony.discovery-campaign-budget/v1\0",
  );
  const bytes = concat([
    prefix,
    hexBytes(input.campaignId, "Campaign ID"),
    ...textPart(input.industryId),
    ...textPart(input.verticalId),
    ...textPart(input.query),
    ...textPart(input.location),
    Uint8Array.of((input.target >>> 8) & 0xff, input.target & 0xff),
    ...textPart(input.language),
    input.region === null
      ? Uint8Array.of(0)
      : concat([Uint8Array.of(1), ...textPart(input.region)]),
    u64(DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD),
    hexBytes(input.payerPubkey, "payer public key"),
  ]);
  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", digestInput),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function approvedCampaignBudgetNanousd(target: number): string {
  if (!Number.isInteger(target) || target < 1 || target > 500) {
    throw new Error("Choose a lead target from 1 to 500.");
  }
  return (BigInt(target) * DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD).toString();
}

export function formatDiscoveryNanousd(value: string | bigint): string {
  const nanousd = typeof value === "bigint" ? value : BigInt(value);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(nanousd) / 1_000_000_000);
}
