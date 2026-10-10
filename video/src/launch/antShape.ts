/**
 * The Colony ant mark as canvas paths. Geometry copied from
 * src/brand/AntMark.tsx (viewBox 0 0 466 309; source of truth docs/BRAND.md).
 * Keep the two in sync by hand.
 */
export const MARK_W = 466;
export const MARK_H = 309;
const LIMB_WIDTH = 14;

export type AntShapes = { body: Path2D; limbs: Path2D };

const BODY: ReadonlyArray<readonly [number, number, number]> = [
  [104, 172, 80],
  [226, 164, 52],
  [313, 148, 46],
];
const LEGS: ReadonlyArray<readonly [number, number, number, number]> = [
  [202, 203, 136, 292],
  [220, 210, 196, 298],
  [235, 209, 246, 300],
  [247, 205, 294, 294],
  [257, 198, 336, 282],
  [164, 215, 112, 272],
];

export function antShapes(): AntShapes {
  const body = new Path2D();
  for (const [cx, cy, r] of BODY) {
    body.moveTo(cx + r, cy);
    body.arc(cx, cy, r, 0, Math.PI * 2);
  }
  const limbs = new Path2D();
  for (const [x1, y1, x2, y2] of LEGS) {
    limbs.moveTo(x1, y1);
    limbs.lineTo(x2, y2);
  }
  limbs.moveTo(327, 114);
  limbs.quadraticCurveTo(345, 64, 397, 50);
  limbs.moveTo(343, 126);
  limbs.quadraticCurveTo(377, 86, 427, 80);
  return { body, limbs };
}

/** One ant centred on (x, y), `size` px long, nose along `angle`. Tiny ants skip the eye. */
export function drawAnt(
  ctx: CanvasRenderingContext2D,
  shapes: AntShapes,
  x: number,
  y: number,
  angle: number,
  size: number,
  color: string,
  alpha: number,
): void {
  const k = size / MARK_W;
  const cos = Math.cos(angle) * k;
  const sin = Math.sin(angle) * k;
  ctx.setTransform(cos, sin, -sin, cos, x, y);
  ctx.translate(-MARK_W / 2, -MARK_H / 2);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = LIMB_WIDTH;
  ctx.lineCap = "round";
  ctx.stroke(shapes.limbs);
  ctx.fill(shapes.body);
}

/** The whole mark, eye cut out, filling `rect`: the shape the swarm lands in. */
export function drawMarkSilhouette(
  ctx: CanvasRenderingContext2D,
  rect: { cx: number; cy: number; width: number; height: number },
): void {
  const shapes = antShapes();
  const k = rect.width / MARK_W;
  ctx.setTransform(
    k,
    0,
    0,
    k,
    rect.cx - rect.width / 2,
    rect.cy - rect.height / 2,
  );
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = LIMB_WIDTH;
  ctx.lineCap = "round";
  ctx.stroke(shapes.limbs);
  ctx.fill(shapes.body);
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(335, 136, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
