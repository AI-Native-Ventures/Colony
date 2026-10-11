import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CAPTIONS,
  CLICK_AT,
  FILM_SECONDS,
  MUSIC_LIFT,
  SCENE_ORDER,
  SCENES,
  VO_LINES,
} from "./film.ts";
import { T_LOGO_IN } from "./timeline.ts";

test("scenes run back to back from 0 to 30 s", () => {
  assert.equal(SCENES[SCENE_ORDER[0]].start, 0);
  for (let i = 1; i < SCENE_ORDER.length; i++) {
    assert.equal(
      SCENES[SCENE_ORDER[i]].start,
      SCENES[SCENE_ORDER[i - 1]].end,
      `${SCENE_ORDER[i]} does not start where ${SCENE_ORDER[i - 1]} ends`,
    );
  }
  assert.equal(SCENES[SCENE_ORDER[SCENE_ORDER.length - 1]].end, FILM_SECONDS);
});

test("every voice line is spoken inside one scene", () => {
  for (const line of VO_LINES) {
    const home = SCENE_ORDER.find(
      (s) =>
        SCENES[s].start <= line.speech[0] && line.speech[1] <= SCENES[s].end,
    );
    assert.ok(home, `${line.id} crosses a scene cut`);
  }
});

test("voice lines never overlap", () => {
  const sorted = [...VO_LINES].sort((a, b) => a.speech[0] - b.speech[0]);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].speech[0] >= sorted[i - 1].speech[1],
      `${sorted[i].id} overlaps ${sorted[i - 1].id}`,
    );
  }
});

test("the Approve click lands while 'your yes' is being said", () => {
  const yes = VO_LINES.find((l) => l.text.includes("your yes"));
  assert.ok(yes, "no line says 'your yes'");
  assert.ok(CLICK_AT >= yes.speech[0] && CLICK_AT <= yes.speech[1]);
});

test("the music lift lands on the logo flash", () => {
  assert.equal(T_LOGO_IN, MUSIC_LIFT);
});

test("every caption stays up long enough to read", () => {
  for (const c of CAPTIONS) {
    const words = c.text.split(/\s+/).length;
    assert.ok(
      c.to - c.from >= words / 3 + 0.5,
      `"${c.text}" is up only ${(c.to - c.from).toFixed(2)} s`,
    );
  }
});

test("no banned marketing word anywhere in the film's source", () => {
  const banned =
    /\b(agents?|workspaces?|models?|channels?|relays?|tokens?|nostr)\b/i;
  const dir = new URL(".", import.meta.url);
  const names = readdirSync(dir, { recursive: true }) as string[];
  for (const name of names) {
    if (!/\.(ts|tsx)$/.test(name) || name.endsWith(".test.ts")) continue;
    const src = readFileSync(new URL(name, dir), "utf8");
    const hit = src.match(banned);
    assert.ok(!hit, `${name} contains "${hit?.[0]}"`);
  }
});
