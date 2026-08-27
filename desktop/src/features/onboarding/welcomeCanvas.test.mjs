import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureWelcomeCanvas,
  WELCOME_CANVAS_CONTENT,
} from "./welcomeCanvas.ts";

test("welcome canvas explains name, role, and team mentions", () => {
  assert.match(WELCOME_CANVAS_CONTENT, /private channel is your home base/i);
  // The three ways to address an employee — the point of separating a personal
  // name from a stable role. The personal-name example must be the shipped
  // guide name, whatever the brand currently calls it.
  assert.match(WELCOME_CANVAS_CONTENT, /@scout/i);
  assert.match(WELCOME_CANVAS_CONTENT, /@chief-of-staff/i);
  assert.match(WELCOME_CANVAS_CONTENT, /@marketing/i);
  assert.match(WELCOME_CANVAS_CONTENT, /renaming someone never breaks/i);
});

test("welcome canvas promises nothing happens without approval", () => {
  assert.match(WELCOME_CANVAS_CONTENT, /blocks in this channel/i);
  assert.match(WELCOME_CANVAS_CONTENT, /until you\s+approve the blueprint/i);
  // Only creation and hiring are gated, so the canvas must not claim work is.
  assert.doesNotMatch(WELCOME_CANVAS_CONTENT, /or start work/i);
});

test("welcome canvas is Colony-facing and names no retired starter agents", () => {
  assert.match(WELCOME_CANVAS_CONTENT, /Welcome to Colony/);
  for (const retired of ["Honey", "Bumble"]) {
    assert.ok(
      !WELCOME_CANVAS_CONTENT.includes(retired),
      `canvas must not introduce ${retired}, which is no longer provisioned`,
    );
  }
});

test("ensureWelcomeCanvas seeds a fresh channel with no canvas", async () => {
  const writes = [];
  const seeded = await ensureWelcomeCanvas("welcome-1", {
    getCanvas: async () => ({ content: "", updatedAt: null, author: null }),
    setCanvas: async (input) => {
      writes.push(input);
      return { ok: true, eventId: "e1" };
    },
  });

  assert.equal(seeded, true);
  assert.deepEqual(writes, [
    { channelId: "welcome-1", content: WELCOME_CANVAS_CONTENT },
  ]);
});

test("ensureWelcomeCanvas seeds even when the backend omits the empty-state fields", async () => {
  // Regression: get_canvas once returned `{ content: "" }` with updated_at and
  // author absent (undefined). `!== null` treated that as an existing canvas
  // and seeding silently never ran for any fresh channel.
  const writes = [];
  const seeded = await ensureWelcomeCanvas("welcome-1", {
    getCanvas: async () => ({ content: "" }),
    setCanvas: async (input) => {
      writes.push(input);
      return { ok: true, eventId: "e1" };
    },
  });

  assert.equal(seeded, true);
  assert.equal(writes.length, 1);
});

test("ensureWelcomeCanvas never overwrites an existing canvas", async () => {
  const seeded = await ensureWelcomeCanvas("welcome-1", {
    getCanvas: async () => ({
      content: "my notes",
      updatedAt: 1_700_000_000,
      author: "a".repeat(64),
    }),
    setCanvas: async () => {
      throw new Error("must not overwrite an existing canvas");
    },
  });

  assert.equal(seeded, false);
});
