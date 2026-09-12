import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COMMUNITY_THEME,
  cacheAndApplyCommunityTheme,
  clearCommunityThemeOutbox,
  communityThemeApplyExpectation,
  communityThemeOutboxKey,
  communityThemePersistenceAction,
  communityThemeScopeFallback,
  communityThemeStorageKey,
  parseCommunityThemePreference,
  readCommunityThemeOutbox,
  readCommunityThemePreference,
  sameCommunityThemePreference,
  writeCommunityThemeOutbox,
  writeCommunityThemePreference,
} from "./communityThemePreference.ts";

function localStorageStub() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test("parses only the versioned stable appearance contract", () => {
  const valid = {
    version: 1,
    theme: "buzz-dark",
    accent: "#3b82f6",
    followSystem: false,
  };
  assert.deepEqual(parseCommunityThemePreference(valid), {
    ...valid,
    gradientPattern: "soft-mesh",
  });
  assert.equal(parseCommunityThemePreference({ ...valid, version: 2 }), null);
  assert.equal(
    parseCommunityThemePreference({ ...valid, theme: "future-theme" }),
    null,
  );
  assert.equal(
    parseCommunityThemePreference({ ...valid, accent: "url(image)" }),
    null,
  );
  assert.equal(
    parseCommunityThemePreference({ ...valid, followSystem: "false" }),
    null,
  );
});

test("old appearance records gain a pattern without losing the chosen accent", () => {
  const old = {
    version: 1,
    theme: "buzz-dark",
    accent: "neutral",
    followSystem: false,
  };
  assert.deepEqual(parseCommunityThemePreference(old), {
    ...old,
    gradientPattern: "soft-mesh",
  });
});

test("pattern edits survive reload, stay community scoped and count as edits", () => {
  globalThis.window = { localStorage: localStorageStub() };
  const halo = { ...DEFAULT_COMMUNITY_THEME, gradientPattern: "halo" };
  const diagonal = {
    ...DEFAULT_COMMUNITY_THEME,
    gradientPattern: "diagonal-wash",
  };
  writeCommunityThemePreference("alice", "wss://a.example", halo);
  writeCommunityThemePreference("alice", "wss://b.example", diagonal);
  assert.deepEqual(
    readCommunityThemePreference("alice", "wss://a.example"),
    halo,
  );
  assert.deepEqual(
    readCommunityThemePreference("alice", "wss://b.example"),
    diagonal,
  );
  assert.equal(sameCommunityThemePreference(halo, diagonal), false);
  assert.equal(communityThemePersistenceAction(null, halo), "persist");
  writeCommunityThemeOutbox("alice", "wss://a.example", halo);
  clearCommunityThemeOutbox("alice", "wss://a.example", diagonal);
  assert.deepEqual(readCommunityThemeOutbox("alice", "wss://a.example"), halo);
});

test("local preferences are isolated by pubkey and normalized relay", () => {
  globalThis.window = { localStorage: localStorageStub() };
  const aliceA = {
    ...DEFAULT_COMMUNITY_THEME,
    theme: "buzz-dark",
    followSystem: false,
  };
  const aliceB = { ...DEFAULT_COMMUNITY_THEME, theme: "buzz" };
  const bobA = { ...DEFAULT_COMMUNITY_THEME, accent: "#ec4899" };
  assert.equal(
    writeCommunityThemePreference("alice", "WSS://A.EXAMPLE/", aliceA),
    true,
  );
  assert.equal(
    writeCommunityThemePreference("alice", "wss://b.example", aliceB),
    true,
  );
  assert.equal(
    writeCommunityThemePreference("bob", "wss://a.example", bobA),
    true,
  );
  assert.deepEqual(
    readCommunityThemePreference("alice", "wss://a.example"),
    aliceA,
  );
  assert.deepEqual(
    readCommunityThemePreference("alice", "wss://b.example/"),
    aliceB,
  );
  assert.deepEqual(
    readCommunityThemePreference("bob", "wss://a.example"),
    bobA,
  );
  assert.notEqual(
    communityThemeStorageKey("alice", "wss://a.example"),
    communityThemeStorageKey("alice", "wss://b.example"),
  );
});

test("dirty outbox survives restart and clears only its exact revision", () => {
  globalThis.window = { localStorage: localStorageStub() };
  const first = { ...DEFAULT_COMMUNITY_THEME, theme: "buzz-dark" };
  const second = { ...DEFAULT_COMMUNITY_THEME, accent: "#ec4899" };

  assert.equal(
    writeCommunityThemeOutbox("alice", "WSS://A.EXAMPLE/", first),
    true,
  );
  assert.deepEqual(readCommunityThemeOutbox("alice", "wss://a.example"), first);
  writeCommunityThemeOutbox("alice", "wss://a.example", second);
  clearCommunityThemeOutbox("alice", "wss://a.example", first);
  assert.deepEqual(
    readCommunityThemeOutbox("alice", "wss://a.example"),
    second,
  );
  clearCommunityThemeOutbox("alice", "wss://a.example", second);
  assert.equal(readCommunityThemeOutbox("alice", "wss://a.example"), null);
  assert.notEqual(
    communityThemeOutboxKey("alice", "wss://a.example"),
    communityThemeStorageKey("alice", "wss://a.example"),
  );
});

test("malformed local data returns null so switching can apply the safe default", () => {
  globalThis.window = { localStorage: localStorageStub() };
  const key = communityThemeStorageKey("alice", "wss://broken.example");
  window.localStorage.setItem(
    key,
    JSON.stringify({ version: 1, theme: "missing" }),
  );
  assert.equal(
    readCommunityThemePreference("alice", "wss://broken.example"),
    null,
  );
  window.localStorage.setItem(key, "{");
  assert.equal(
    readCommunityThemePreference("alice", "wss://broken.example"),
    null,
  );
});

test("remote preference still applies when its local cache write fails", () => {
  globalThis.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    },
  };
  let applied = null;
  cacheAndApplyCommunityTheme(
    "alice",
    "wss://a.example",
    DEFAULT_COMMUNITY_THEME,
    (preference) => {
      applied = preference;
    },
  );
  assert.deepEqual(applied, DEFAULT_COMMUNITY_THEME);
});

test("already-applied relay state leaves the next user edit publishable", () => {
  const applied = {
    ...DEFAULT_COMMUNITY_THEME,
    theme: "buzz",
    followSystem: false,
  };

  assert.equal(communityThemeApplyExpectation(applied, applied), null);
  assert.deepEqual(
    communityThemeApplyExpectation(applied, DEFAULT_COMMUNITY_THEME),
    applied,
  );
});

test("no-op initialization remains programmatic", () => {
  const expectation = communityThemeApplyExpectation(
    DEFAULT_COMMUNITY_THEME,
    DEFAULT_COMMUNITY_THEME,
    true,
  );

  assert.equal(
    communityThemePersistenceAction(expectation, DEFAULT_COMMUNITY_THEME),
    "acknowledge",
  );
});

test("confirmed first-community migration isolates later empty scopes", () => {
  const inherited = {
    ...DEFAULT_COMMUNITY_THEME,
    theme: "dracula",
    followSystem: false,
  };

  assert.deepEqual(communityThemeScopeFallback(false, inherited), inherited);
  assert.deepEqual(
    communityThemeScopeFallback(true, inherited),
    DEFAULT_COMMUNITY_THEME,
  );
});

test("community switch defers stale outgoing appearance persistence", () => {
  const outgoing = {
    ...DEFAULT_COMMUNITY_THEME,
    theme: "buzz-dark",
    followSystem: false,
  };
  const incoming = {
    ...DEFAULT_COMMUNITY_THEME,
    theme: "buzz",
  };

  assert.equal(communityThemePersistenceAction(incoming, outgoing), "defer");
  assert.equal(
    communityThemePersistenceAction(incoming, incoming),
    "acknowledge",
  );
  assert.equal(communityThemePersistenceAction(null, incoming), "persist");
});

test("legacy styles migrate to Default without losing mode or accent", () => {
  for (const [legacy, theme] of [
    ["houston", "buzz-dark"],
    ["catppuccin-latte", "buzz"],
  ]) {
    const stored = {
      ...DEFAULT_COMMUNITY_THEME,
      theme: legacy,
      accent: "#3b82f6",
      followSystem: false,
    };
    assert.deepEqual(parseCommunityThemePreference(stored), {
      ...stored,
      theme,
    });
  }
});

test("custom gradients survive cache and outbox round trips independently per community", () => {
  globalThis.window = { localStorage: localStorageStub() };
  const preference = {
    ...DEFAULT_COMMUNITY_THEME,
    customGradient: { enabled: true, color1: "#123456", color2: "#abcdef" },
  };
  writeCommunityThemePreference("alice", "wss://a.example", preference);
  writeCommunityThemeOutbox("alice", "wss://a.example", preference);
  assert.deepEqual(
    readCommunityThemePreference("alice", "wss://a.example"),
    preference,
  );
  assert.deepEqual(
    readCommunityThemeOutbox("alice", "wss://a.example"),
    preference,
  );
  assert.equal(readCommunityThemePreference("alice", "wss://b.example"), null);
  const edited = {
    ...preference,
    customGradient: { ...preference.customGradient, color2: "#112233" },
  };
  assert.equal(sameCommunityThemePreference(preference, edited), false);
  clearCommunityThemeOutbox("alice", "wss://a.example", edited);
  assert.deepEqual(
    readCommunityThemeOutbox("alice", "wss://a.example"),
    preference,
  );
  assert.equal(
    communityThemePersistenceAction(preference, DEFAULT_COMMUNITY_THEME),
    "defer",
  );
  assert.equal(
    communityThemePersistenceAction(preference, preference),
    "acknowledge",
  );
  assert.equal(
    parseCommunityThemePreference({
      ...preference,
      customGradient: { ...preference.customGradient, color2: "red" },
    }),
    null,
  );
  assert.equal(
    sameCommunityThemePreference(preference, {
      ...preference,
      customGradient: { ...preference.customGradient, enabled: false },
    }),
    false,
  );
});
