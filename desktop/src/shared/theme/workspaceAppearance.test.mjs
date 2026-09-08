import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkspaceAppearance,
  deriveWorkspaceAppearance,
  parseWorkspaceGradientPattern,
  workspaceGradientCss,
  WORKSPACE_GRADIENT_PATTERNS,
} from "./workspaceAppearance.ts";

function luminance(hex) {
  const rgb = hex
    .slice(1)
    .match(/../g)
    .map((part) => Number.parseInt(part, 16) / 255);
  const [r, g, b] = rgb.map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("all brand families change the reading surface and keep text readable", () => {
  const accents = ["#895AF6", "#ec4899", "#22c55e"];
  for (const mode of ["light", "dark"]) {
    const palettes = accents.map(
      (accent) => deriveWorkspaceAppearance(accent)[mode],
    );
    assert.equal(new Set(palettes.map((p) => p.content)).size, accents.length);
    for (const p of palettes) {
      for (const surface of [p.content, p.raised, p.muted]) {
        assert.ok(
          contrast(surface, p.foreground) >= 7,
          `${mode} body contrast`,
        );
        assert.ok(
          contrast(surface, p.mutedForeground) >= 4.5,
          `${mode} secondary contrast`,
        );
      }
      for (const surface of [p.chromeStart, p.chromeMiddle, p.chromeEnd]) {
        assert.ok(
          contrast(surface, p.foreground) >= 7,
          `${mode} navigation contrast`,
        );
      }
    }
  }
});

test("Neutral and grey choices never acquire a coloured surface", () => {
  for (const accent of ["neutral", "#808080", "#ffffff", "#000000"]) {
    const palettes = deriveWorkspaceAppearance(accent);
    for (const p of Object.values(palettes)) {
      for (const hex of Object.values(p)) {
        const channels = hex.slice(1).match(/../g);
        assert.equal(
          new Set(channels).size,
          1,
          `${accent} must remain neutral`,
        );
      }
    }
  }
});

test("pattern previews share distinct static backgrounds with the app", () => {
  const palette = deriveWorkspaceAppearance("#895AF6").light;
  const backgrounds = WORKSPACE_GRADIENT_PATTERNS.map(({ value }) =>
    workspaceGradientCss(value, palette),
  );
  assert.equal(new Set(backgrounds).size, 3);
  const properties = new Map();
  const root = {
    dataset: {},
    style: { setProperty: (key, value) => properties.set(key, value) },
  };
  for (const { value } of WORKSPACE_GRADIENT_PATTERNS) {
    applyWorkspaceAppearance(root, "#895AF6", value);
    assert.equal(root.dataset.workspaceGradient, value);
    assert.equal(
      properties.get("--buzz-workspace-gradient-light"),
      workspaceGradientCss(value, palette),
    );
  }
  assert.equal(
    properties.has("--background"),
    false,
    "non-Colony themes retain their base surface",
  );
  assert.equal(
    properties.has("--primary"),
    false,
    "workspace styling does not replace the selected accent",
  );
});

test("old and unknown pattern values safely default without losing valid choices", () => {
  for (const value of [undefined, null, "", "future-pattern", {}]) {
    assert.equal(parseWorkspaceGradientPattern(value), "soft-mesh");
  }
  for (const { value } of WORKSPACE_GRADIENT_PATTERNS) {
    assert.equal(parseWorkspaceGradientPattern(value), value);
  }
});
