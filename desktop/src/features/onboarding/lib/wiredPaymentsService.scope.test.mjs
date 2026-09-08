import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

const key = new Uint8Array(32).fill(3);
const otherKey = new Uint8Array(32).fill(4);
const owner = getPublicKey(key);
const scope = { ownerPubkey: owner, relayUrl: "wss://horizon.example" };
let activeOwner,
  activeRelay,
  httpBase,
  signedWith,
  afterBase,
  afterSign,
  calls,
  requests;
beforeEach(() => {
  activeOwner = owner;
  activeRelay = scope.relayUrl;
  httpBase = "https://horizon.example";
  signedWith = key;
  afterBase = afterSign = () => {};
  calls = [];
  requests = [];
});
mock.module("@/shared/api/nativeBridge", {
  namedExports: {
    invoke: async (command, input) => {
      calls.push(command);
      switch (command) {
        case "get_identity":
          return { pubkey: activeOwner, display_name: "Founder" };
        case "get_relay_ws_url":
          return activeRelay;
        case "get_relay_http_url": {
          const base = httpBase;
          afterBase();
          return base;
        }
        case "sign_event": {
          const event = finalizeEvent(
            {
              kind: input.kind,
              content: input.content,
              tags: input.tags,
              created_at: 1000,
            },
            signedWith,
          );
          afterSign();
          return JSON.stringify(event);
        }
        default:
          throw new Error(`Unexpected native command: ${command}`);
      }
    },
  },
});
const { createWiredPaymentsService } = await import(
  "./wiredPaymentsService.ts"
);

function transport(t) {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return {
      status: 200,
      json: async () =>
        String(url).endsWith("/packs")
          ? {
              currency: "ZAR",
              packs: [
                {
                  id: "starter",
                  name: "Starter",
                  zarCents: 100,
                  usdCents: 10,
                  grantNanousd: 100000000,
                },
              ],
            }
          : {
              reference: "checkout-one",
              authorizationUrl: "https://checkout.example/one",
            },
    };
  });
}

test("scoped checkout signs and posts only the captured account and business", async (t) => {
  transport(t);
  const service = createWiredPaymentsService(scope);
  const catalogue = await service.packs();
  assert.equal(catalogue.currency, "ZAR");
  await service.createTransaction("starter", "FOUNDER@example.com");
  const { url, options } = requests[1];
  assert.equal(url, "https://horizon.example/api/payments/initialize");
  assert.deepEqual(JSON.parse(options.body), {
    packId: "starter",
    email: "founder@example.com",
  });
  const auth = JSON.parse(
    atob(options.headers.Authorization.slice("Nostr ".length)),
  );
  assert.equal(auth.pubkey, owner);
  assert.ok(auth.tags.some((tag) => tag[0] === "u" && tag[1] === url));
});

test("community changed while resolving HTTP base never reaches payment initialization", async (t) => {
  transport(t);
  afterBase = () => {
    activeRelay = "wss://another.example";
  };
  await assert.rejects(
    createWiredPaymentsService(scope).createTransaction(
      "starter",
      "founder@example.com",
    ),
  );
  assert.equal(requests.length, 0);
  assert.ok(!calls.includes("sign_event"));
});

test("HTTP/WS destination disagreement cannot silently send to another tenant", async (t) => {
  transport(t);
  httpBase = "https://another.example";
  await assert.rejects(createWiredPaymentsService(scope).packs());
  assert.equal(requests.length, 0);
});

test("owner change after signing or wrong native signer stops before POST", async (t) => {
  transport(t);
  afterSign = () => {
    activeOwner = getPublicKey(otherKey);
  };
  await assert.rejects(
    createWiredPaymentsService(scope).createTransaction(
      "starter",
      "founder@example.com",
    ),
  );
  assert.equal(requests.length, 0);
  activeOwner = owner;
  afterSign = () => {};
  signedWith = otherKey;
  await assert.rejects(
    createWiredPaymentsService(scope).createTransaction(
      "starter",
      "founder@example.com",
    ),
  );
  assert.equal(requests.length, 0);
});

test("existing unscoped price-list callers keep their original public read behaviour", async (t) => {
  transport(t);
  const result = await createWiredPaymentsService().packs();
  assert.equal(result.currency, "ZAR");
  assert.deepEqual(calls, ["get_relay_http_url"]);
  assert.equal(requests.length, 1);
});
