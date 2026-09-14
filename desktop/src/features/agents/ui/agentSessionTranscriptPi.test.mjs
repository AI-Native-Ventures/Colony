import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscript } from "./agentSessionTranscript.ts";

test("Pi metadata replacement prompt produces a standalone system prompt card", () => {
  const events = [
    {
      seq: 1,
      timestamp: "2026-09-09T00:00:00Z",
      kind: "acp_write",
      agentIndex: 0,
      channelId: "11111111-1111-1111-1111-111111111111",
      sessionId: "pi-session",
      turnId: "turn-1",
      payload: {
        method: "session/new",
        params: {
          _meta: {
            sessionTitle: "Pi fixture",
            systemPrompt: "[Base]\nBuzz base\n\n[System]\nPersona",
          },
        },
      },
    },
  ];
  const cards = buildTranscript(events).filter(
    (item) => item.acpSource === "session/new",
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].turnId, null);
  assert.deepEqual(
    cards[0].sections.map((section) => section.body),
    ["Buzz base", "Persona"],
  );
});

test("Pi metadata replace object produces a standalone system prompt card", () => {
  const events = [
    {
      seq: 1,
      timestamp: "2026-09-09T00:00:00Z",
      kind: "acp_write",
      agentIndex: 0,
      channelId: "11111111-1111-1111-1111-111111111111",
      sessionId: "pi-session",
      turnId: "turn-1",
      payload: {
        method: "session/new",
        params: {
          _meta: {
            sessionTitle: "Pi fixture",
            systemPrompt: {
              replace: "[Base]\nBuzz base\n\n[System]\nPersona",
            },
          },
        },
      },
    },
  ];
  const cards = buildTranscript(events).filter(
    (item) => item.acpSource === "session/new",
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].turnId, null);
  assert.deepEqual(
    cards[0].sections.map((section) => section.body),
    ["Buzz base", "Persona"],
  );
});
