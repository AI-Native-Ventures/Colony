import net from "node:net";

import { PreviewArtifactError } from "./errors.mjs";

const BLOCKED_NAME_SUFFIXES = Object.freeze([
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
]);

function invalidAddress(address) {
  return new PreviewArtifactError(
    "dns-invalid-address",
    `not a valid IP address: ${JSON.stringify(address)}`,
    { address },
  );
}

function parseIpv4(address) {
  const parts = address.split(".");
  if (parts.length !== 4) throw invalidAddress(address);
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) throw invalidAddress(address);
    return Number(part);
  });
  if (octets.some((value) => value > 255)) throw invalidAddress(address);
  return octets;
}

function parseIpv6(address) {
  const text = address.toLowerCase();
  if (text.includes("%")) throw invalidAddress(address);
  const sections = text.split("::");
  if (sections.length > 2) throw invalidAddress(address);

  const expandEmbeddedIpv4 = (segments) => {
    const last = segments[segments.length - 1];
    if (last === undefined || !last.includes(".")) return segments;
    const octets = parseIpv4(last);
    return [
      ...segments.slice(0, -1),
      (octets[0] << 8) | octets[1],
      (octets[2] << 8) | octets[3],
    ];
  };

  let head =
    sections[0] === "" ? [] : expandEmbeddedIpv4(sections[0].split(":"));
  let tail = null;
  if (sections.length === 2) {
    tail = sections[1] === "" ? [] : expandEmbeddedIpv4(sections[1].split(":"));
  }

  const toSegments = (groups) =>
    groups.map((group) => {
      if (typeof group === "number") return group;
      if (!/^[0-9a-f]{1,4}$/.test(group)) throw invalidAddress(address);
      return Number.parseInt(group, 16);
    });
  head = toSegments(head);
  if (tail !== null) tail = toSegments(tail);

  if (tail === null) {
    if (head.length !== 8) throw invalidAddress(address);
    return head;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 1) throw invalidAddress(address);
  return [...head, ...new Array(missing).fill(0), ...tail];
}

function embeddedIpv4([, , , , , , high, low]) {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isPrivateIpv4(octets) {
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(segments) {
  const [s0, s1, s2, s3, s4, s5] = segments;
  const compatible = s0 === 0 && s1 === 0 && s2 === 0 && s3 === 0 && s4 === 0;
  if (compatible && (s5 === 0 || s5 === 0xffff)) {
    return isPrivateIpv4(embeddedIpv4(segments));
  }
  const nat64WellKnown =
    s0 === 0x0064 &&
    s1 === 0xff9b &&
    s2 === 0 &&
    s3 === 0 &&
    s4 === 0 &&
    s5 === 0;
  if (nat64WellKnown) return isPrivateIpv4(embeddedIpv4(segments));
  const ipv4Translated =
    s0 === 0 && s1 === 0 && s2 === 0 && s3 === 0 && s4 === 0xffff && s5 === 0;
  if (ipv4Translated) return isPrivateIpv4(embeddedIpv4(segments));

  return (
    (s0 & 0xfe00) === 0xfc00 ||
    (s0 & 0xffc0) === 0xfe80 ||
    (s0 & 0xffc0) === 0xfec0 ||
    (s0 & 0xff00) === 0xff00 ||
    (s0 === 0x0100 && s1 === 0 && s2 === 0 && s3 === 0) ||
    (s0 === 0x0064 && s1 === 0xff9b && s2 === 1) ||
    (s0 === 0x2001 && s1 === 0x0000) ||
    (s0 === 0x2001 && s1 === 0x0002 && s2 === 0) ||
    (s0 === 0x2001 && (s1 & 0xfff0) === 0x0010) ||
    (s0 === 0x2001 && (s1 & 0xfff0) === 0x0020) ||
    (s0 === 0x2001 && s1 === 0x0db8) ||
    s0 === 0x2002 ||
    (s0 === 0x3fff && (s1 & 0xf000) === 0) ||
    s0 === 0x5f00
  );
}

/**
 * Classify one IP address as non-global for website preview purposes.
 *
 * Deliberately stricter than `buzz_core::network::is_private_ip`: in addition
 * to private, loopback, link-local, and shared space it rejects multicast,
 * reserved, documentation, protocol-only, and special-use IPv6 ranges. This
 * does not change buzz-core network policy.
 *
 * @param {string} address bare IPv4 or IPv6 address, no brackets or zone
 * @returns {boolean} true for private, reserved, or otherwise non-public space
 */
export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(parseIpv4(address));
  if (family === 6) return isPrivateIpv6(parseIpv6(address));
  throw invalidAddress(address);
}

function normalizeHostName(name) {
  return name.toLowerCase().replace(/\.+$/, "");
}

/**
 * Split a URL hostname into an IP literal or a normalized DNS name.
 * Terminal dots are removed and names are lower-cased before classification.
 */
export function classifyHost(hostname) {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const normalized = normalizeHostName(bare);
  if (net.isIP(normalized) !== 0) return { kind: "ip", address: normalized };
  return { kind: "name", name: normalized };
}

/**
 * Names refused before any resolution, after terminal-dot and case
 * normalization.
 */
export function isBlockedHostName(name) {
  const normalized = normalizeHostName(name);
  return (
    normalized === "localhost" ||
    BLOCKED_NAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix)) ||
    !normalized.includes(".")
  );
}
