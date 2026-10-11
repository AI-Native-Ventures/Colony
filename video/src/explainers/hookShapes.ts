import { drawCroissantSilhouette } from "./croissantShape.ts";

/**
 * The trade's tool that the hook's ants build, one per explainer. Icon
 * shapes use Material icon paths (Apache 2.0) in a 24 px box; the others are
 * drawn from simple canvas shapes in their own box.
 */
export const HOOK_SHAPE_IDS = [
  "croissant",
  "hardHat",
  "scissors",
  "wrench",
  "camera",
  "car",
  "sprayBottle",
  "chefHat",
] as const;
export type HookShapeId = (typeof HOOK_SHAPE_IDS)[number];

/** How wide each shape is built, in frame pixels: thin tools need more room for the ants to read. */
export const HOOK_SHAPE_WIDTH: Record<HookShapeId, number> = {
  croissant: 780,
  hardHat: 640,
  scissors: 560,
  wrench: 540,
  camera: 600,
  car: 640,
  sprayBottle: 460,
  chefHat: 560,
};

const ICONS: Partial<Record<HookShapeId, string>> = {
  wrench:
    "M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z",
  scissors:
    "M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zM19 3l-6 6 2 2 7-7V3z",
  camera:
    "M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z",
  car: "M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z",
};

/** Sets up a box of `boxW` by `boxH` units so its centre lands on (cx, cy) and it is `width` px wide. */
function enterBox(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  width: number,
  boxW: number,
  boxH: number,
): void {
  const k = width / boxW;
  ctx.translate(cx - (boxW / 2) * k, cy - (boxH / 2) * k);
  ctx.scale(k, k);
}

function gaps(
  ctx: CanvasRenderingContext2D,
  lines: readonly [number, number, number, number][],
  width: number,
): void {
  ctx.globalCompositeOperation = "destination-out";
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  for (const [x1, y1, x2, y2] of lines) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
}

/** A builder's hard hat: dome, ridge and brim, in a 200 by 120 box. */
function hardHat(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.ellipse(100, 84, 70, 66, 0, Math.PI, Math.PI * 2);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(12, 80, 176, 22, 11);
  ctx.fill();
  gaps(
    ctx,
    [
      [84, 30, 82, 78],
      [116, 30, 118, 78],
      [24, 82, 176, 82],
    ],
    4,
  );
}

/** A trigger spray bottle, in a 160 by 200 box. */
function sprayBottle(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.roundRect(46, 86, 76, 108, 18);
  ctx.fill();
  ctx.beginPath();
  ctx.rect(66, 62, 36, 28);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(42, 22);
  ctx.lineTo(118, 22);
  ctx.lineTo(126, 62);
  ctx.lineTo(52, 62);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.rect(18, 28, 26, 12);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(70, 62);
  ctx.lineTo(56, 104);
  ctx.lineTo(66, 106);
  ctx.lineTo(80, 64);
  ctx.closePath();
  ctx.fill();
}

/** A chef's hat: three puffs over a band, in a 200 by 160 box. */
function chefHat(ctx: CanvasRenderingContext2D): void {
  for (const [x, y, r] of [
    [58, 70, 38],
    [100, 50, 46],
    [142, 70, 38],
  ] as const) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.rect(52, 70, 96, 62);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(50, 132, 100, 24, 6);
  ctx.fill();
  gaps(
    ctx,
    [
      [56, 132, 144, 132],
      [82, 88, 84, 126],
      [118, 88, 116, 126],
    ],
    4,
  );
}

/** Fills hook shape `id`'s silhouette, `width` px wide, centred on (cx, cy). */
export function drawHookShape(
  id: HookShapeId,
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  width: number,
): void {
  if (id === "croissant") {
    drawCroissantSilhouette(ctx, cx, cy, width);
    return;
  }
  ctx.save();
  ctx.fillStyle = "#000";
  const icon = ICONS[id];
  if (icon) {
    enterBox(ctx, cx, cy, width, 24, 24);
    ctx.fill(new Path2D(icon));
  } else if (id === "hardHat") {
    enterBox(ctx, cx, cy, width, 200, 120);
    hardHat(ctx);
  } else if (id === "sprayBottle") {
    enterBox(ctx, cx, cy, width, 160, 200);
    sprayBottle(ctx);
  } else {
    enterBox(ctx, cx, cy, width, 200, 160);
    chefHat(ctx);
  }
  ctx.restore();
}
