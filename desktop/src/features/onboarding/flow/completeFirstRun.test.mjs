import assert from "node:assert/strict";
import { test } from "node:test";

import { createOnboardingV2Draft } from "../onboardingV2.ts";
import { completeFirstRun } from "./completeFirstRun.ts";

function makeIo(overrides = {}) {
  const calls = [];
  return {
    calls,
    io: {
      initializeStarterChannels: async () => {
        calls.push("channels");
        return { ok: true, focusChannelId: "chan-1" };
      },
      updateProfile: async (input) => {
        calls.push(`profile:${input.displayName}`);
        return {};
      },
      hasMarker: async () => false,
      sendFirstTask: async () => {
        calls.push("task");
        return { eventId: "evt-9" };
      },
      markComplete: (pubkey, relayUrl) => {
        calls.push(`complete:${pubkey}:${relayUrl}`);
      },
      rememberFounderBrief: () => calls.push("brief"),
      takePendingWelcomeChannelForDirectEntry: () => {},
      navigateToChannel: (id) => calls.push(`nav:${id}`),
      ...overrides,
    },
  };
}

const base = createOnboardingV2Draft();
const draft = {
  ...base,
  firstTask: { ...base.firstTask, content: "Get to know Acme." },
};

test("happy path: channels, profile, task, gate key, navigation", async () => {
  const { io, calls } = makeIo();
  const result = await completeFirstRun(
    {
      queryClient: {},
      relayUrl: "wss://acme.test",
      pubkey: "pk1",
      draft,
      profileDisplayName: "Aisha Bello",
      profileAvatarUrl: null,
    },
    io,
  );
  assert.equal(result.focusChannelId, "chan-1");
  assert.equal(result.firstTaskEventId, "evt-9");
  assert.deepEqual(calls, [
    "channels",
    "profile:Aisha Bello",
    "nav:chan-1",
    "brief",
    "task",
    "complete:pk1:wss://acme.test",
  ]);
});

// Delivery is a network write; landing is not. A founder whose brief fails to
// send still owns a working workspace, and they can only retry from inside it.
test("a failed brief still lands the founder in Welcome", async () => {
  const { io, calls } = makeIo({
    sendFirstTask: async () => {
      calls.push("task");
      throw new Error("relay refused the message");
    },
  });
  await assert.rejects(
    completeFirstRun(
      {
        queryClient: {},
        relayUrl: "wss://acme.test",
        pubkey: "pk1",
        draft,
        profileDisplayName: null,
        profileAvatarUrl: null,
      },
      io,
    ),
    /relay refused the message/,
  );
  assert.deepEqual(calls, ["channels", "nav:chan-1", "brief", "task"]);
});

test("skips delivery when the marker already exists", async () => {
  const { io, calls } = makeIo({ hasMarker: async () => true });
  const result = await completeFirstRun(
    {
      queryClient: {},
      relayUrl: "wss://r",
      pubkey: "pk",
      draft,
      profileDisplayName: null,
      profileAvatarUrl: null,
    },
    io,
  );
  assert.equal(result.firstTaskEventId, "already-delivered");
  assert.ok(!calls.includes("task"));
  assert.ok(!calls.some((c) => c.startsWith("profile:")));
});

test("skips delivery when draft is null or content empty", async () => {
  const { io, calls } = makeIo();
  await completeFirstRun(
    {
      queryClient: {},
      relayUrl: "wss://r",
      pubkey: "pk",
      draft: null,
      profileDisplayName: null,
      profileAvatarUrl: null,
    },
    io,
  );
  assert.ok(!calls.includes("task"));
});

test("throws when starter channels fail without a focus channel", async () => {
  const { io } = makeIo({
    initializeStarterChannels: async () => ({ ok: false, reason: "boom" }),
  });
  await assert.rejects(
    completeFirstRun(
      {
        queryClient: {},
        relayUrl: "wss://r",
        pubkey: "pk",
        draft: null,
        profileDisplayName: null,
        profileAvatarUrl: null,
      },
      io,
    ),
    /boom/,
  );
});

test("profile write failure preserves setup for retry without losing the owner's name", async () => {
  const { io, calls } = makeIo({
    updateProfile: async () => {
      throw new Error("profile down");
    },
  });
  await assert.rejects(
    completeFirstRun(
      {
        queryClient: {},
        relayUrl: "wss://r",
        pubkey: "pk",
        draft: null,
        profileDisplayName: "Aisha",
        profileAvatarUrl: null,
      },
      io,
    ),
    /could not save your profile/,
  );
  assert.deepEqual(calls, ["channels"]);
});

test("the founder's photo is published with their name, in one profile write", async () => {
  // Collected on the account screen; the previous flow had a dedicated avatar
  // step and the redesign folded it away, which silently dropped the picture.
  // One kind:0 carries both: writing them separately would publish two
  // replaceable events where one will do.
  const written = [];
  const { io } = makeIo({
    updateProfile: async (input) => {
      written.push(input);
      return {};
    },
  });
  await completeFirstRun(
    {
      queryClient: {},
      relayUrl: "wss://acme.test",
      pubkey: "pk1",
      draft,
      profileDisplayName: "Aisha Bello",
      profileAvatarUrl: "https://cdn.test/aisha.png",
    },
    io,
  );
  assert.deepEqual(written, [
    { displayName: "Aisha Bello", avatarUrl: "https://cdn.test/aisha.png" },
  ]);
});

test("skipping the photo leaves an existing avatar alone", async () => {
  // `avatarUrl` is omitted rather than sent blank: kind:0 is replaceable, so a
  // blank field would clear a picture the founder set on another device.
  const written = [];
  const { io } = makeIo({
    updateProfile: async (input) => {
      written.push(input);
      return {};
    },
  });
  await completeFirstRun(
    {
      queryClient: {},
      relayUrl: "wss://acme.test",
      pubkey: "pk1",
      draft,
      profileDisplayName: "Aisha Bello",
      profileAvatarUrl: "   ",
    },
    io,
  );
  assert.deepEqual(written, [{ displayName: "Aisha Bello" }]);
});

test("a photo with no name still reaches the profile", async () => {
  const written = [];
  const { io } = makeIo({
    updateProfile: async (input) => {
      written.push(input);
      return {};
    },
  });
  await completeFirstRun(
    {
      queryClient: {},
      relayUrl: "wss://acme.test",
      pubkey: "pk1",
      draft,
      profileDisplayName: null,
      profileAvatarUrl: "https://cdn.test/aisha.png",
    },
    io,
  );
  assert.deepEqual(written, [{ avatarUrl: "https://cdn.test/aisha.png" }]);
});

test("leaving during channel setup stops the old run before profile and task writes", async () => {
  let current = true;
  const { io, calls } = makeIo({
    initializeStarterChannels: async () => {
      calls.push("channels");
      current = false;
      return { ok: true, focusChannelId: "chan-1" };
    },
  });
  await assert.rejects(
    completeFirstRun(
      {
        queryClient: {},
        relayUrl: "wss://acme.test",
        pubkey: "pk1",
        draft,
        profileDisplayName: "Owner",
        profileAvatarUrl: null,
        assertCurrent: () => {
          if (!current) throw new Error("Run ended");
        },
      },
      io,
    ),
    /Run ended/,
  );
  assert.deepEqual(calls, ["channels"]);
});

const suggestionDraft = {
  ...draft,
  company: {
    ...draft.company,
    name: "Horizon Labs",
    summary: "Branding for service businesses",
  },
  firstTask: {
    ...draft.firstTask,
    mode: "suggestion",
    deliveryMarker: "setup-123",
  },
};
const suggestionDeps = {
  queryClient: {},
  relayUrl: "wss://acme.test",
  pubkey: "a".repeat(64),
  draft: suggestionDraft,
  profileDisplayName: null,
  profileAvatarUrl: null,
};
test("new first run saves explicit handoff before Welcome and focuses the actual suggestion root", async () => {
  const root = "b".repeat(64);
  const { io, calls } = makeIo({
    markExplicitHandoff: async (scope) => {
      assert.equal(scope.ownerPubkey, suggestionDeps.pubkey);
      calls.push("explicit");
    },
    deliverSuggestion: async (payload, marker) => {
      assert.equal(payload.businessName, "Horizon Labs");
      assert.equal(payload.business, "Branding for service businesses");
      assert.equal(payload.requestId, "setup-123");
      assert.match(marker, /setup-123/);
      calls.push("suggestion");
      return { eventId: root };
    },
    navigateToThread: (channel, eventId) =>
      calls.push(`thread:${channel}:${eventId}`),
  });
  const result = await completeFirstRun(suggestionDeps, io);
  assert.equal(result.firstTaskEventId, root);
  assert.deepEqual(calls, [
    "explicit",
    "channels",
    "nav:chan-1",
    "suggestion",
    `thread:chan-1:${root}`,
    `complete:${suggestionDeps.pubkey}:wss://acme.test`,
  ]);
});
test("new first run cannot create Welcome when durable explicit mode is unavailable", async () => {
  const { io, calls } = makeIo({
    markExplicitHandoff: async () => {
      throw new Error("storage failed");
    },
    deliverSuggestion: async () => ({ eventId: "b".repeat(64) }),
    navigateToThread: () => {},
  });
  await assert.rejects(completeFirstRun(suggestionDeps, io), /storage failed/);
  assert.deepEqual(calls, []);
});
test("new first run never completes or invents a thread after uncertain suggestion delivery", async () => {
  const { io, calls } = makeIo({
    markExplicitHandoff: async () => calls.push("explicit"),
    deliverSuggestion: async () => {
      throw new Error("acknowledgement lost");
    },
    navigateToThread: () => calls.push("thread"),
  });
  await assert.rejects(
    completeFirstRun(suggestionDeps, io),
    /acknowledgement lost/,
  );
  assert.deepEqual(calls, ["explicit", "channels", "nav:chan-1"]);
});
test("suggestion mode fails before effects if explicit adapters are absent", async () => {
  const { io, calls } = makeIo();
  await assert.rejects(
    completeFirstRun(suggestionDeps, io),
    /handoff.*unavailable/i,
  );
  assert.deepEqual(calls, []);
});
