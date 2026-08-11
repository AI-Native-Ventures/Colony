import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNip98Event,
  encodeSignedEvent,
  selectOperatorSigner,
  type OperatorSigner,
} from "./operatorAuth";
import { analyticsRequest } from "./api";

function signer(source: "nip07" | "nip46" = "nip07"): OperatorSigner {
  let counter = 0;
  return {
    source,
    getPublicKey: vi.fn(async () => "11".repeat(32)),
    signEvent: vi.fn(async (event) => ({
      ...event,
      id: `${counter++}`.padStart(64, "0"),
      pubkey: "11".repeat(32),
      sig: "22".repeat(64),
    })),
  };
}

describe("operator signer selection", () => {
  it("prefers NIP-07 over the remote bridge", () => {
    const nip07 = { getPublicKey: vi.fn(), signEvent: vi.fn() };
    const bridge = { getPublicKey: vi.fn(), signEvent: vi.fn() };
    expect(
      selectOperatorSigner({ nostr: nip07, colonyOperatorSigner: bridge })
        .source,
    ).toBe("nip07");
  });

  it("falls back to the Colony remote signer", () => {
    const bridge = { getPublicKey: vi.fn(), signEvent: vi.fn() };
    expect(selectOperatorSigner({ colonyOperatorSigner: bridge }).source).toBe(
      "nip46",
    );
  });
});

describe("analyticsRequest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal(
      "location",
      new URL("https://operator.example.test/analytics"),
    );
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "nonce-uuid") });
    const storage = {
      length: 0,
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", { ...storage });
  });

  it("signs an exact URL and method with a fresh nonce and compact NIP-98 header", async () => {
    const currentSigner = signer();
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: { ok: true },
            as_of: "2026-08-09T12:00:00Z",
            freshness: {
              historical: {
                status: "fresh",
                watermark: "2026-08-09T11:59:00Z",
              },
              live: { status: "fresh", observed_at: "2026-08-09T12:00:00Z" },
            },
            definitions_version: "v1",
            warnings: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await analyticsRequest<{ ok: boolean }>(
      "/operator/analytics/overview",
      currentSigner,
    );
    const second = await analyticsRequest<{ ok: boolean }>(
      "/operator/analytics/overview",
      currentSigner,
    );
    expect(first.data.ok).toBe(true);
    expect(second.data.ok).toBe(true);
    expect(currentSigner.getPublicKey).toHaveBeenCalledTimes(2);
    expect(currentSigner.signEvent).toHaveBeenCalledTimes(2);
    const event = vi.mocked(currentSigner.signEvent).mock.calls[0][0];
    expect(event.kind).toBe(27235);
    expect(event.content).toBe("");
    expect(event.tags).toEqual([
      ["u", "https://operator.example.test/operator/analytics/overview"],
      ["method", "GET"],
      ["nonce", "nonce-uuid"],
    ]);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({
      accept: "application/json",
      Authorization: expect.stringMatching(/^Nostr [A-Za-z0-9+/=]+$/),
    });
    expect(init?.body).toBeUndefined();
    expect(localStorage.getItem("operator-key")).toBeNull();
    expect(sessionStorage.getItem("operator-key")).toBeNull();
  });

  it("creates compact base64 JSON without mutating storage", () => {
    const event = {
      ...createNip98Event(
        "https://operator.example.test/operator/analytics/overview",
        "GET",
      ),
      id: "00".repeat(32),
      pubkey: "11".repeat(32),
      sig: "22".repeat(64),
    };
    expect(atob(encodeSignedEvent(event))).toBe(JSON.stringify(event));
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
