import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyHost,
  isBlockedHostName,
  isPrivateAddress,
} from "./address.mjs";

function assertClassified(expected, addresses) {
  for (const address of addresses) {
    assert.equal(isPrivateAddress(address), expected, address);
  }
}

test("classifies dotted and hexadecimal embedded IPv4 identically", () => {
  const equivalentPairs = [
    ["::ffff:10.0.0.1", "::ffff:0a00:0001", true],
    ["::ffff:127.0.0.1", "::ffff:7f00:0001", true],
    ["::10.0.0.1", "::0a00:0001", true],
    ["::ffff:0:10.0.0.1", "::ffff:0:0a00:0001", true],
    ["64:ff9b::10.0.0.1", "64:ff9b::0a00:0001", true],
    ["64:ff9b::192.168.7.9", "64:ff9b::c0a8:0709", true],
    ["::ffff:8.8.8.8", "::ffff:0808:0808", false],
    ["::8.8.8.8", "::0808:0808", false],
    ["::ffff:0:8.8.8.8", "::ffff:0:0808:0808", false],
    ["64:ff9b::8.8.8.8", "64:ff9b::0808:0808", false],
    ["64:ff9b::93.184.216.34", "64:ff9b::5db8:d822", false],
  ];
  for (const [dotted, hexadecimal, expected] of equivalentPairs) {
    assert.equal(isPrivateAddress(dotted), expected, dotted);
    assert.equal(isPrivateAddress(hexadecimal), expected, hexadecimal);
  }
});

test("rejects IPv4 multicast, reserved, documentation, and protocol-only ranges", () => {
  assertClassified(true, [
    "224.0.0.1",
    "233.252.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "250.10.20.30",
    "255.255.255.255",
    "192.0.2.1",
    "198.51.100.10",
    "203.0.113.200",
    "192.0.0.1",
    "192.0.0.170",
    "192.88.99.1",
  ]);
  assertClassified(false, [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "100.63.255.255",
    "100.128.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "203.0.114.1",
    "223.255.255.254",
  ]);
});

test("rejects IPv6 special-use and transition space", () => {
  assertClassified(true, [
    "::",
    "::1",
    "100::1",
    "2001::1",
    "2001:2::1",
    "2001:10::1",
    "2001:20::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
    "5f00::1",
    "fec0::1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "64:ff9b:1::1",
    "::ffff:127.0.0.1",
  ]);
  assertClassified(false, [
    "2001:1::1",
    "2000:ffff::1",
    "2606:4700::1111",
    "2404:6800:4003::1",
    "2a00:1450:4001:81b::200e",
    "64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff",
  ]);
});

test("normalizes terminal dots and case before blocked-name checks", () => {
  const blocked = [
    "localhost",
    "localhost.",
    "LocalHost.",
    "localhost..",
    "internal",
    "api.local",
    "api.local.",
    "API.LOCAL.",
    "service.internal.",
    "host.home.arpa.",
    "nested.local..",
  ];
  for (const name of blocked) {
    assert.equal(isBlockedHostName(name), true, name);
    assert.equal(isBlockedHostName(classifyHost(name).name), true, name);
  }

  const allowed = [
    "example.com",
    "example.com.",
    "cdn.example.com.",
    "Sub.Public.Example.Com.",
    "local.example.com.",
    "localhost.example.com.",
    "not-local.example.com",
    "mylocal.example",
  ];
  for (const name of allowed) {
    assert.equal(isBlockedHostName(name), false, name);
  }
});

test("classifyHost keeps public FQDNs and detects literals", () => {
  assert.deepEqual(classifyHost("api.local."), {
    kind: "name",
    name: "api.local",
  });
  assert.deepEqual(classifyHost("CDN.EXAMPLE.COM."), {
    kind: "name",
    name: "cdn.example.com",
  });
  assert.deepEqual(classifyHost("93.184.216.34"), {
    kind: "ip",
    address: "93.184.216.34",
  });
  assert.deepEqual(classifyHost("[2606:4700::1]"), {
    kind: "ip",
    address: "2606:4700::1",
  });
  assert.deepEqual(classifyHost("127.0.0.1."), {
    kind: "ip",
    address: "127.0.0.1",
  });
  assert.equal(isBlockedHostName(classifyHost("API.LOCAL.").name), true);
});

test("rejects malformed IP literals", () => {
  for (const address of [
    "999.1.1.1",
    "1.2.3",
    "1.2.3.4.5",
    "::ffff:300.1.1.1",
    "fe80::1%eth0",
  ]) {
    assert.throws(
      () => isPrivateAddress(address),
      (error) => error?.code === "dns-invalid-address",
      address,
    );
  }
});
