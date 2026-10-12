import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cameraAt,
  frameFor,
  MOVE_SECONDS,
  project,
  projectBox,
} from "./camera.ts";
import { CAPTION_TOP, FRAME, WINDOW } from "./stage.ts";

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test("at zoom 1 on the whole window the stage barely moves", () => {
  const cam = frameFor(WINDOW, 1);
  assert.equal(cam.scale, 1);
  assert.ok(Math.abs(cam.x) < 1 && Math.abs(cam.y) < 25, JSON.stringify(cam));
});

test("a focus box lands in the middle of the view above the captions", () => {
  const focus = { x: 800, y: 400, w: 200, h: 60 };
  const cam = frameFor(focus, 1.6);
  const centre = project({ x: 900, y: 430 }, cam);
  assert.ok(near(centre.x, FRAME.w / 2), `${centre.x}`);
  assert.ok(near(centre.y, CAPTION_TOP / 2), `${centre.y}`);
});

test("zoomed into a corner, the window still fills the view: no backdrop gap", () => {
  const corner = { x: WINDOW.x, y: WINDOW.y, w: 120, h: 40 };
  const cam = frameFor(corner, 2);
  const window = projectBox(WINDOW, cam);
  assert.ok(window.x <= 0 + 1e-6, `left edge at ${window.x}`);
  assert.ok(window.y <= 0 + 1e-6, `top edge at ${window.y}`);
});

test("the camera holds its first key, eases into the next, then holds it", () => {
  const keys = [
    { at: 0, focus: WINDOW, zoom: 1 },
    { at: 2, focus: { x: 800, y: 400, w: 200, h: 60 }, zoom: 1.6 },
  ];
  assert.deepEqual(cameraAt(-1, keys), frameFor(WINDOW, 1));
  assert.deepEqual(cameraAt(1.9, keys), frameFor(WINDOW, 1));
  assert.deepEqual(
    cameraAt(2 + MOVE_SECONDS + 0.01, keys),
    frameFor(keys[1].focus, 1.6),
  );
  const mid = cameraAt(2 + MOVE_SECONDS / 2, keys);
  assert.ok(mid.scale > 1 && mid.scale < 1.6, `${mid.scale}`);
});
