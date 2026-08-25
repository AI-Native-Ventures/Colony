// desktop/src/shared/theme/imposedNeutralAccent.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCENT_STORAGE_KEY,
  NEUTRAL_ACCENT,
  THEME_STORAGE_KEY,
  migrateImposedNeutralAccent,
} from "./ThemeProvider.tsx";

const MIGRATION_KEY = "buzz-accent-neutral-migrated.v1";

function withStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  globalThis.window = {
    localStorage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, String(value)),
      removeItem: (key) => data.delete(key),
    },
  };
  globalThis.localStorage = globalThis.window.localStorage;
  return data;
}

test("the imposed neutral is dropped so the brand default applies", () => {
  const data = withStorage({
    [ACCENT_STORAGE_KEY]: NEUTRAL_ACCENT,
    [THEME_STORAGE_KEY]: "buzz",
  });
  migrateImposedNeutralAccent();
  assert.equal(data.get(ACCENT_STORAGE_KEY), undefined);
  assert.equal(data.get(MIGRATION_KEY), "done");
});

test("an accent someone chose is never touched", () => {
  // The bug this replaces was a storage-key bump, which discarded every
  // accent ever chosen in order to retire one value nobody chose.
  for (const accent of ["#6366f1", "#ec4899", "#3b82f6"]) {
    const data = withStorage({
      [ACCENT_STORAGE_KEY]: accent,
      [THEME_STORAGE_KEY]: "buzz",
    });
    migrateImposedNeutralAccent();
    assert.equal(data.get(ACCENT_STORAGE_KEY), accent);
  }
});

test("neutral chosen after the sweep stays chosen", () => {
  // What makes this a migration rather than a rule: it runs once, and a later
  // choice of neutral is a choice.
  const data = withStorage({
    [ACCENT_STORAGE_KEY]: NEUTRAL_ACCENT,
    [THEME_STORAGE_KEY]: "buzz",
  });
  migrateImposedNeutralAccent();
  data.set(ACCENT_STORAGE_KEY, NEUTRAL_ACCENT);
  migrateImposedNeutralAccent();
  assert.equal(data.get(ACCENT_STORAGE_KEY), NEUTRAL_ACCENT);
});

test("an install with no stored accent still records the sweep", () => {
  const data = withStorage();
  migrateImposedNeutralAccent();
  assert.equal(data.get(MIGRATION_KEY), "done");
  assert.equal(data.get(ACCENT_STORAGE_KEY), undefined);
});

test("neutral on a theme that never imposed it is a choice and survives", () => {
  // Only Colony themes forced the accent while hiding the picker. Anywhere
  // else the picker was on screen, so neutral there was picked on purpose;
  // sweeping it would be the same overreach as bumping the storage key.
  for (const theme of ["catppuccin-latte", "houston", "github-light"]) {
    const data = withStorage({
      [ACCENT_STORAGE_KEY]: NEUTRAL_ACCENT,
      [THEME_STORAGE_KEY]: theme,
    });
    migrateImposedNeutralAccent();
    assert.equal(data.get(ACCENT_STORAGE_KEY), NEUTRAL_ACCENT, theme);
  }
});
