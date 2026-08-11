/**
 * Unit tests for relay URL normalization and probe helpers (D4).
 *
 * normalizeRelayUrl is pure and fully testable. probeRelayReachable requires
 * a WebSocket runtime — its contract (cancel-safe, timeout-bounded, close-
 * on-all-exits) is verified by the E2E onboarding specs on CI shards.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRelayUrl } from "./relayProbe.ts";

// ---------------------------------------------------------------------------
// Valid inputs
// ---------------------------------------------------------------------------

test("normalizeRelayUrl_wss_passthrough", () => {
  assert.equal(
    normalizeRelayUrl("wss://relay.example.com"),
    "wss://relay.example.com",
  );
});

test("normalizeRelayUrl_ws_passthrough", () => {
  // Scheme passes through; the loopback host is canonicalised to 127.0.0.1 so
  // the app lands on the same community its managed agents will.
  assert.equal(normalizeRelayUrl("ws://127.0.0.1:3000"), "ws://127.0.0.1:3000");
  assert.equal(normalizeRelayUrl("ws://localhost:3000"), "ws://127.0.0.1:3000");
});

test("normalizeRelayUrl_https_converts_to_wss", () => {
  assert.equal(
    normalizeRelayUrl("https://relay.example.com"),
    "wss://relay.example.com",
  );
});

test("normalizeRelayUrl_http_converts_to_ws", () => {
  assert.equal(
    normalizeRelayUrl("http://localhost:3000"),
    "ws://127.0.0.1:3000",
  );
});

test("normalizeRelayUrl_strips_trailing_slashes", () => {
  assert.equal(
    normalizeRelayUrl("wss://relay.example.com///"),
    "wss://relay.example.com",
  );
});

test("normalizeRelayUrl_trims_whitespace", () => {
  assert.equal(
    normalizeRelayUrl("  wss://relay.example.com  "),
    "wss://relay.example.com",
  );
});

test("normalizeRelayUrl_https_with_port_converts_to_wss", () => {
  assert.equal(
    normalizeRelayUrl("https://relay.example.com:8443"),
    "wss://relay.example.com:8443",
  );
});

test("normalizeRelayUrl_wss_with_path_preserves_path", () => {
  assert.equal(
    normalizeRelayUrl("wss://relay.example.com/custom"),
    "wss://relay.example.com/custom",
  );
});

// ---------------------------------------------------------------------------
// Invalid / rejected inputs
// ---------------------------------------------------------------------------

test("normalizeRelayUrl_empty_returns_null", () => {
  assert.equal(normalizeRelayUrl(""), null);
  assert.equal(normalizeRelayUrl("   "), null);
});

test("normalizeRelayUrl_bare_hostname_adds_secure_scheme", () => {
  assert.equal(
    normalizeRelayUrl("relay.example.com"),
    "wss://relay.example.com",
  );
});

test("normalizeRelayUrl_ftp_scheme_returns_null", () => {
  assert.equal(normalizeRelayUrl("ftp://relay.example.com"), null);
});

test("normalizeRelayUrl_garbage_returns_null", () => {
  assert.equal(normalizeRelayUrl("not a url at all"), null);
});

// ---------------------------------------------------------------------------
// Loopback canonicalisation
//
// The relay binds a community from the request Host, and deliberately does NOT
// alias loopback spellings (see "No loopback aliasing" in buzz-auth/nip98.rs).
// buzz-core canonicalises loopback to 127.0.0.1 before the desktop hands a
// relay URL to a managed agent, so a user who typed `localhost` ended up with
// the app on one community and its agents 404-ing against another.
// ---------------------------------------------------------------------------

test("normalizeRelayUrl_canonicalizes_localhost_to_loopback_ip", () => {
  assert.equal(normalizeRelayUrl("ws://localhost:3200"), "ws://127.0.0.1:3200");
});

test("normalizeRelayUrl_canonicalizes_ipv6_loopback", () => {
  assert.equal(normalizeRelayUrl("ws://[::1]:3200"), "ws://127.0.0.1:3200");
});

test("normalizeRelayUrl_canonicalizes_loopback_from_http_scheme", () => {
  assert.equal(
    normalizeRelayUrl("http://localhost:3200"),
    "ws://127.0.0.1:3200",
  );
});

test("normalizeRelayUrl_loopback_spellings_agree", () => {
  const spellings = [
    "ws://localhost:3200",
    "ws://127.0.0.1:3200",
    "ws://[::1]:3200",
    "http://localhost:3200",
  ].map(normalizeRelayUrl);
  assert.equal(
    new Set(spellings).size,
    1,
    `expected one identity, got ${spellings}`,
  );
});

test("normalizeRelayUrl_preserves_the_port", () => {
  assert.equal(normalizeRelayUrl("ws://localhost:3000"), "ws://127.0.0.1:3000");
  assert.equal(normalizeRelayUrl("ws://localhost:3200"), "ws://127.0.0.1:3200");
});

test("normalizeRelayUrl_never_rewrites_a_real_host", () => {
  assert.equal(
    normalizeRelayUrl("wss://relay.colony.ainative.ventures"),
    "wss://relay.colony.ainative.ventures",
  );
  // A host that merely contains "localhost" is a different machine entirely.
  assert.equal(
    normalizeRelayUrl("wss://localhost.evil.example"),
    "wss://localhost.evil.example",
  );
});
