/**
 * Harness-logo coverage guard.
 *
 * Every tier-2 preset the backend emits must have a bundled logo, or it renders
 * as the generic TerminalSquare fallback next to siblings that show real marks.
 * The two sides live in different languages — Rust `PRESET_HARNESSES` vs the TS
 * `HARNESS_LOGOS` record — so no compiler catches drift, and `RuntimeIcon`'s
 * `onError` fallback hides a missing file at runtime. This test reads the Rust
 * source as text (the same trick `motion.test.mjs` uses for CSS) and asserts
 * both directions plus on-disk existence of every mapped file.
 *
 * Logo keys are checked against BOTH backend tiers — `PRESET_HARNESSES` and the
 * compiled-in `KNOWN_ACP_RUNTIMES` table. A harness can be promoted from preset
 * to first-class runtime (OpenCode was, on 2026-08-23) and must keep its mark
 * across that move: a logo belongs to a harness, not to a tier. Checking only
 * the preset list turned that promotion into a failure of this very test.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RUNTIME_MARKS } from "./HarnessMarks.tsx";
import { HARNESS_LOGOS } from "./RuntimeIcon.tsx";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/** Pull the `id: "..."` values out of one Rust slice literal. */
function parseIds(source, blockPattern, what) {
  const block = source.match(blockPattern);
  assert.ok(block, `could not locate ${what}`);
  return [...block[1].matchAll(/^\s{8}id: "([^"]+)",$/gm)].map(
    (match) => match[1],
  );
}

const presetIds = parseIds(
  readFileSync(
    path.join(desktopRoot, "src-tauri/src/managed_agents/discovery/presets.rs"),
    "utf8",
  ),
  /const PRESET_HARNESSES: &\[PresetHarness\] = &\[([\s\S]*?)\n\];/,
  "PRESET_HARNESSES in presets.rs",
);

const builtinIds = parseIds(
  readFileSync(
    path.join(desktopRoot, "src-tauri/src/managed_agents/discovery.rs"),
    "utf8",
  ),
  /const KNOWN_ACP_RUNTIMES: &\[KnownAcpRuntime\] = &\[([\s\S]*?)\n\];/,
  "KNOWN_ACP_RUNTIMES in discovery.rs",
);

const knownHarnessIds = [...presetIds, ...builtinIds];

test("PRESET_HARNESSES parse found the preset ids", () => {
  // Guards the regex itself: a struct-field rename would otherwise silently
  // yield zero ids and make every assertion below vacuously pass.
  assert.ok(
    presetIds.length >= 3,
    `expected at least 3 preset ids, parsed ${presetIds.length}`,
  );
});

test("KNOWN_ACP_RUNTIMES parse found the builtin ids", () => {
  // Same vacuous-pass guard for the second source. Without it, a failed parse
  // would make the unknown-key assertion below reject every builtin logo.
  assert.ok(
    builtinIds.includes("claude") && builtinIds.includes("codex"),
    `expected claude and codex among builtin ids, parsed ${builtinIds.join(", ")}`,
  );
});

for (const id of presetIds) {
  test(`preset "${id}" has a bundled logo or inline mark`, () => {
    // Inline SVG marks (RUNTIME_MARKS) take precedence over bitmap logos —
    // e.g. Cursor's mark ships as an inline CC0 simple-icons path, not a
    // file under desktop/public.
    if (RUNTIME_MARKS[id]) {
      return;
    }
    const logoPath = HARNESS_LOGOS[id];
    assert.ok(
      logoPath,
      `preset "${id}" has no RUNTIME_MARKS or HARNESS_LOGOS entry — it renders ` +
        `the generic TerminalSquare fallback. Add desktop/public${logoPath ?? `/harness-logos/${id}.png`} ` +
        `and map it in RuntimeIcon.tsx.`,
    );
    assert.ok(
      existsSync(path.join(desktopRoot, "public", logoPath)),
      `HARNESS_LOGOS["${id}"] points at ${logoPath}, which is missing from ` +
        `desktop/public — RuntimeIcon's onError would silently fall back.`,
    );
  });
}

test("HARNESS_LOGOS has no entries for unknown harnesses", () => {
  const unknown = Object.keys(HARNESS_LOGOS).filter(
    (id) => !knownHarnessIds.includes(id),
  );
  assert.deepEqual(
    unknown,
    [],
    `HARNESS_LOGOS maps ids the backend emits from neither PRESET_HARNESSES ` +
      `nor KNOWN_ACP_RUNTIMES: ${unknown.join(", ")}`,
  );
});

test("opencode keeps its bundled logo as a first-class runtime", () => {
  // Regression pin. OpenCode was promoted out of PRESET_HARNESSES into
  // KNOWN_ACP_RUNTIMES; its logo file and mapping must survive the move, and
  // the mapping must not be dropped merely because it is no longer a preset.
  assert.ok(
    builtinIds.includes("opencode"),
    "opencode must be a compiled-in runtime, not a preset",
  );
  const logoPath = HARNESS_LOGOS.opencode;
  assert.ok(logoPath, "opencode lost its HARNESS_LOGOS entry");
  assert.ok(
    existsSync(path.join(desktopRoot, "public", logoPath)),
    `HARNESS_LOGOS.opencode points at ${logoPath}, missing from desktop/public`,
  );
});

test("codex ships no bundled mark or logo (vendor-removed OpenAI blossom)", () => {
  // The OpenAI blossom was removed from simple-icons v16 at the vendor's
  // request — Codex must render RuntimeIcon's neutral terminal-glyph
  // fallback, not a re-bundled copy of the withdrawn mark.
  assert.equal(
    RUNTIME_MARKS.codex,
    undefined,
    "codex has a RUNTIME_MARKS entry — the OpenAI blossom must not ship without explicit approval",
  );
  assert.equal(
    HARNESS_LOGOS.codex,
    undefined,
    "codex has a HARNESS_LOGOS entry — no bundled Codex logo is approved",
  );
});
