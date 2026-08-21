// desktop/src/features/onboarding/ui/new/screenStyles.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "onboarding-screens.css"), "utf8");

function renderedClasses() {
  const dirs = [here, join(here, "screens")];
  const found = new Set();
  for (const dir of dirs) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".tsx")) continue;
      const source = readFileSync(join(dir, file), "utf8");
      for (const match of source.matchAll(/onb-[a-z0-9-]+/g)) {
        found.add(match[0]);
      }
    }
  }
  return [...found];
}

test("every_rendered_screen_class_has_a_style_rule", () => {
  const canvas = readFileSync(join(here, "onboarding-canvas.css"), "utf8");
  const missing = renderedClasses().filter(
    (name) => !css.includes(`.${name}`) && !canvas.includes(`.${name}`),
  );
  assert.deepEqual(
    missing,
    [],
    `classes with no CSS rule: ${missing.join(", ")}`,
  );
});

test("screen_styles_are_layered", () => {
  // Unlayered CSS beats Tailwind's utilities regardless of specificity, which
  // silently defeats call-site overrides. See docs/BRAND.md.
  assert.ok(css.includes("@layer components"));
});

test("fieldset_defaults_are_reset", () => {
  // BusinessScreen groups its questions in fieldsets, which arrive with a
  // browser border, padding and margin.
  assert.match(css, /fieldset[^{]*\{[^}]*border:\s*0/);
});
