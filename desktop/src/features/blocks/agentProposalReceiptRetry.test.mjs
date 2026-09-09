import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { canonicalBlockJson } from "./blockValidation.ts";

const dom = new JSDOM("<!doctype html><body></body>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
after(() => dom.window.close());

const ownerKey = generateSecretKey();
const agentKey = generateSecretKey();
const ownerPubkey = getPublicKey(ownerKey);
const agentPubkey = getPublicKey(agentKey);
const channelId = "36411e44-0e2d-4cfe-bd6e-567eb169db9f";
const instanceId = "11111111-1111-4111-8111-111111111111";
const manifestId = "b".repeat(64);
const instance = finalizeEvent(
  {
    kind: 9,
    created_at: 1,
    content: "Review Researcher.",
    tags: [
      ["h", channelId],
      ["p", ownerPubkey],
      ["e", manifestId, "", "block"],
      ["block", "1", "agent-proposal", manifestId, instanceId],
      ["block-attention", "1", "required"],
      [
        "block-data",
        canonicalBlockJson({
          mode: "create",
          requestId: instanceId,
          channelId,
          displayName: "Researcher",
          systemPrompt: "Research leads.",
        }),
      ],
    ],
  },
  agentKey,
);
const action = finalizeEvent(
  {
    kind: 40010,
    created_at: 2,
    content: JSON.stringify({
      requestId: instanceId,
      definition: {
        displayName: "Researcher",
        systemPrompt: "Research leads.",
        runtime: "codex",
        behavior: { respondTo: "owner-only", parallelism: 2 },
      },
      runOn: { type: "local" },
    }),
    tags: [
      ["h", channelId],
      ["p", ownerPubkey],
      ["e", instance.id, "", "block-instance"],
      ["e", manifestId, "", "block-manifest"],
      [
        "block-action",
        "1",
        "agent.create",
        instanceId,
        "33333333-3333-4333-8333-333333333333",
      ],
    ],
  },
  ownerKey,
);
const agents = [{ pubkey: agentPubkey }];
const channels = [
  { id: channelId, isMember: true, memberPubkeys: [agentPubkey] },
];
const personas = [];
const storedReceipts = [];
let executionCount = 0;
let publicationCount = 0;
let failFirstPublication = true;
let holdReceiptRead;
let executionOutcomes;
beforeEach(() => {
  executionCount = 0;
  publicationCount = 0;
  storedReceipts.length = 0;
  failFirstPublication = true;
  holdReceiptRead = undefined;
  executionOutcomes = [
    {
      status: "applied",
      definitionId: "created-definition",
      agentPubkey,
      recovered: false,
    },
  ];
});

mock.module("@/shared/api/hooks", {
  namedExports: {
    useIdentityQuery: () => ({ data: { pubkey: ownerPubkey } }),
  },
});
mock.module("@/features/agents/hooks", {
  namedExports: {
    useManagedAgentsQuery: () => ({ data: agents }),
    usePersonasQuery: () => ({ data: personas }),
  },
});
mock.module("@/features/channels/hooks", {
  namedExports: {
    useChannelsQuery: () => ({ data: channels }),
  },
});
mock.module("@/shared/api/agentProposals", {
  namedExports: {
    executeAgentProposal: async () => {
      executionCount += 1;
      return (
        executionOutcomes.shift() ?? {
          status: "failed",
          safeMessage: "The configured native result was already consumed.",
        }
      );
    },
  },
});
mock.module("@/shared/api/tauri", {
  namedExports: {
    signRelayEvent: async ({ kind, content, tags }) =>
      finalizeEvent(
        {
          kind,
          content,
          tags,
          created_at: 3,
        },
        ownerKey,
      ),
  },
});
mock.module("@/shared/api/relayClient", {
  namedExports: {
    relayClient: {
      fetchEvents: async ({ kinds, "#e": references }) => {
        if (kinds[0] === 9) return [instance];
        if (kinds[0] === 40010) return [action];
        if (holdReceiptRead && executionCount === 1) {
          const held = holdReceiptRead;
          holdReceiptRead = undefined;
          return held;
        }
        return storedReceipts.filter((receipt) =>
          receipt.tags.some(
            (tag) => tag[0] === "e" && references.includes(tag[1]),
          ),
        );
      },
      publishEvent: async (receipt) => {
        publicationCount += 1;
        if (failFirstPublication && publicationCount === 1)
          throw new Error("Transient receipt publication failure");
        storedReceipts.push(receipt);
      },
      subscribeToReconnects: () => () => {},
      subscribeLive: async () => () => {},
    },
  },
});

test("a replaced community lease cannot publish or reuse its retained native result", async () => {
  const { createElement, act } = await import("react");
  const { render, waitFor, cleanup } = await import("@testing-library/react");
  const { useAgentProposalBroker } = await import(
    "./useAgentProposalBroker.ts"
  );
  failFirstPublication = false;
  let releaseRead;
  holdReceiptRead = new Promise((resolve) => {
    releaseRead = resolve;
  });
  executionOutcomes.push({
    status: "applied",
    definitionId: "replacement-lease-result",
    agentPubkey,
    recovered: true,
  });
  function Broker({ scope }) {
    useAgentProposalBroker({
      communityExecutionScope: scope,
      relayUrl: `wss://${scope}.test`,
    });
    return null;
  }
  const view = render(createElement(Broker, { scope: "old-community" }));
  try {
    await waitFor(() => assert.equal(executionCount, 1));
    assert.equal(
      publicationCount,
      0,
      "old lease is paused before receipt publication",
    );
    view.rerender(createElement(Broker, { scope: "new-community" }));
    await waitFor(() => assert.equal(storedReceipts.length, 1));
    await act(async () => {
      releaseRead([]);
    });
    assert.equal(
      executionCount,
      2,
      "new lease must independently recover through native idempotency",
    );
    assert.equal(
      publicationCount,
      1,
      "the revoked lease must never publish its prior result",
    );
    assert.equal(
      JSON.parse(storedReceipts[0].content).definitionId,
      "replacement-lease-result",
    );
  } finally {
    releaseRead([]);
    cleanup();
  }
});

test("receipt publication retry preserves an applied native result without executing again", async () => {
  const { createElement } = await import("react");
  const { render, waitFor, cleanup } = await import("@testing-library/react");
  const { useAgentProposalBroker, validateAgentProposalActionContext } =
    await import("./useAgentProposalBroker.ts");
  assert.ok(
    validateAgentProposalActionContext({
      actionEvent: action,
      instanceEvent: instance,
      context: { ownerPubkey, managedAgents: agents, channels, personas },
    }),
  );
  function Broker() {
    useAgentProposalBroker({
      communityExecutionScope: "receipt-retry",
      relayUrl: "wss://relay.test",
    });
    return null;
  }
  render(createElement(Broker));
  try {
    await waitFor(() =>
      assert.equal(
        storedReceipts.length,
        1,
        `native calls ${executionCount}, receipt publications ${publicationCount}`,
      ),
    );
    assert.equal(publicationCount, 2, "a real failed publish must be retried");
    assert.equal(
      executionCount,
      1,
      "retry must only publish the already-known result",
    );
    assert.equal(JSON.parse(storedReceipts[0].content).outcome, "created");
  } finally {
    cleanup();
  }
});
