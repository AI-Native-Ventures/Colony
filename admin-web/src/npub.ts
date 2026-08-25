/**
 * Minimal bech32 npub encoder for display surfaces.
 *
 * admin-web has no nostr dependency and only ever needs one direction:
 * hex pubkey to npub1… so the operator can hand a submitter key to someone
 * running a Nostr client. Returns null for anything that is not a 64-char
 * hex key rather than throwing.
 */

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const BECH32_GENERATOR = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
];

function bech32Polymod(values: number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if (((top >> i) & 1) === 1) {
        checksum ^= BECH32_GENERATOR[i];
      }
    }
  }
  return checksum;
}

function bech32HrpExpand(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (const char of hrp) {
    high.push(char.charCodeAt(0) >> 5);
    low.push(char.charCodeAt(0) & 31);
  }
  return [...high, 0, ...low];
}

function bech32Checksum(hrp: string, data: number[]): number[] {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const polymod = bech32Polymod(values) ^ 1;
  const result: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    result.push((polymod >> (5 * (5 - i))) & 31);
  }
  return result;
}

function convertBitsTo5(data: number[]): number[] {
  let accumulator = 0;
  let bits = 0;
  const words: number[] = [];
  for (const byte of data) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >> bits) & 31);
    }
  }
  if (bits > 0) {
    words.push((accumulator << (5 - bits)) & 31);
  }
  return words;
}

export function pubkeyToNpub(hexPubkey: string): string | null {
  const hex = hexPubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return null;
  }
  const bytes = (hex.match(/../g) ?? []).map((pair) =>
    Number.parseInt(pair, 16),
  );
  const data = convertBitsTo5(bytes);
  const checksum = bech32Checksum("npub", data);
  return `npub1${[...data, ...checksum]
    .map((word) => BECH32_CHARSET[word])
    .join("")}`;
}
