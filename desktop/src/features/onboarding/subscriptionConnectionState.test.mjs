import assert from "node:assert/strict";
import test from "node:test";
import {
  subscriptionConnectionReady,
  subscriptionEffortAllowed,
  subscriptionExhausted,
  subscriptionModelDefaultEffort,
  subscriptionModelEfforts,
} from "./subscriptionConnectionState.ts";
import {
  MOCK_SUBSCRIPTION_CONNECTIONS,
  createMockSubscriptionConnections,
} from "../../testing/e2eBridgeSubscriptions.ts";

const found = MOCK_SUBSCRIPTION_CONNECTIONS[0];
const usable = { ...found, connected: found.detected };
const model = found.detected.models[0].id;

test("external detection never substitutes for a connected usable account", () => {
  assert.equal(subscriptionConnectionReady(found, model, 100), false);
  assert.equal(subscriptionConnectionReady(usable, model, 100), true);
  assert.equal(
    subscriptionConnectionReady(
      { ...usable, launchError: "Unavailable" },
      model,
      100,
    ),
    false,
  );
  assert.equal(
    subscriptionConnectionReady(usable, "unoffered-model", 100),
    false,
  );
});

test("missing usage is unknown while active account exhaustion blocks readiness", () => {
  const account = {
    ...usable.connected,
    measurementStatus: "unavailable",
    windows: [],
  };
  assert.equal(
    subscriptionConnectionReady({ ...usable, connected: account }, model, 100),
    true,
  );
  const window = {
    id: "primary",
    usedPercent: 100,
    resetsAt: 200,
    accountWide: true,
  };
  assert.equal(
    subscriptionExhausted(
      { ...account, measurementStatus: "live", windows: [window] },
      100,
    ),
    true,
  );
  assert.equal(
    subscriptionExhausted(
      { ...account, measurementStatus: "live", windows: [window] },
      201,
    ),
    false,
  );
  assert.equal(
    subscriptionExhausted(
      {
        ...account,
        measurementStatus: "live",
        windows: [{ ...window, accountWide: false }],
      },
      100,
    ),
    false,
  );
});

test("connecting a fixture account does not connect another owner or business", () => {
  const provider = createMockSubscriptionConnections();
  const scope = {
    ownerPubkey: "owner-one",
    relayUrl: "wss://one.example.test",
  };
  provider.connect({ runtimeId: found.runtimeId, scope });
  assert.equal(
    provider.read({ scope })[0].connected.authentication,
    "subscription",
  );
  assert.equal(
    provider.read({ scope: { ...scope, ownerPubkey: "owner-two" } })[0]
      .connected.authentication,
    "signed_out",
  );
  assert.equal(
    provider.read({
      scope: { ...scope, relayUrl: "wss://two.example.test" },
    })[0].connected.authentication,
    "signed_out",
  );
});

test("only an effort the chosen model advertised can be carried into readiness", () => {
  assert.deepEqual(
    subscriptionModelEfforts(usable, model).map((entry) => entry.effort),
    ["low", "high", "max"],
  );
  assert.deepEqual(subscriptionModelEfforts(usable, "unoffered-model"), []);
  assert.equal(subscriptionEffortAllowed(usable, model, null), true);
  assert.equal(subscriptionEffortAllowed(usable, model, "max"), true);
  assert.equal(subscriptionEffortAllowed(usable, model, "ultra"), false);
  // Readiness must refuse a stale effort rather than let the bridge reject the
  // teammate after the owner has already left the screen.
  assert.equal(subscriptionConnectionReady(usable, model, 100, "max"), true);
  assert.equal(subscriptionConnectionReady(usable, model, 100, "ultra"), false);
  assert.equal(subscriptionConnectionReady(usable, model, 100), true);
});

test("a provider that names no default effort preselects none", () => {
  assert.equal(subscriptionModelDefaultEffort(usable, model), null);
  const withDefault = {
    ...usable,
    connected: {
      ...usable.connected,
      models: [
        {
          ...usable.connected.models[0],
          defaultEffort: "high",
        },
      ],
    },
  };
  assert.equal(subscriptionModelDefaultEffort(withDefault, model), "high");
  const unlisted = {
    ...withDefault,
    connected: {
      ...withDefault.connected,
      models: [{ ...withDefault.connected.models[0], defaultEffort: "ultra" }],
    },
  };
  assert.equal(
    subscriptionModelDefaultEffort(unlisted, model),
    null,
    "a default the model does not list is not a choice we can make for the owner",
  );
});
