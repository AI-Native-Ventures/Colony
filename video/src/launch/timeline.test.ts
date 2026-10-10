import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { antColor } from "./colors.ts";
import { FRAME_W, LOGO_RECT, TEXT_MAX_WIDTH, timeAt } from "./timeline.ts";

test("timing is in seconds, so 30 and 60 fps agree", () => {
  assert.equal(timeAt(90, 30), timeAt(180, 60));
  assert.equal(timeAt(168, 30), 5.6);
});

test("the logo keeps the 466:309 brand ratio", () => {
  assert.ok(Math.abs(LOGO_RECT.width / LOGO_RECT.height - 466 / 309) < 1e-9);
});

test("words stay inside the safe area (x 90..940)", () => {
  const left = FRAME_W / 2 - TEXT_MAX_WIDTH / 2;
  const right = FRAME_W / 2 + TEXT_MAX_WIDTH / 2;
  assert.ok(left >= 90, `left edge ${left}`);
  assert.ok(right <= 940, `right edge ${right}`);
});

test("ant colors run white, then employee color, then violet", () => {
  assert.equal(antColor(0, 0, 0), "rgb(244 243 248)");
  assert.equal(antColor(0, 1, 0), "rgb(60 131 246)");
  assert.equal(antColor(2, 1, 1), "rgb(137 90 246)");
});

test("uniting into violet flashes bright instead of passing through mud", () => {
  const [r, g, b] = antColor(1, 1, 0.5).slice(4, -1).split(" ").map(Number);
  assert.ok(Math.min(r, g, b) >= 200, `mid-unite color rgb(${r} ${g} ${b})`);
});

test("no unseeded randomness anywhere in the launch film", () => {
  const dir = new URL(".", import.meta.url);
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".test.ts")) continue;
    const src = readFileSync(new URL(name, dir), "utf8");
    assert.ok(!src.includes("Math.random"), `${name} uses Math.random`);
  }
});
