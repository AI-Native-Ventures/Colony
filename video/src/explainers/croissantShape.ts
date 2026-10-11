/** A croissant as five ellipses on a curve, in a 200 by 120 box: tips first, the middle on top. */
export const CROISSANT_SEGMENTS = [
  { cx: 30, cy: 90, rx: 21, ry: 11, rot: -56 },
  { cx: 170, cy: 90, rx: 21, ry: 11, rot: 56 },
  { cx: 58, cy: 66, rx: 29, ry: 22, rot: -33 },
  { cx: 142, cy: 66, rx: 29, ry: 22, rot: 33 },
  { cx: 100, cy: 54, rx: 34, ry: 32, rot: 0 },
] as const;

/** Where one ridge meets the next: a short line across the silhouette, in the same box. */
const RIDGES = [
  { x1: 38, y1: 62, x2: 52, y2: 92 },
  { x1: 162, y1: 62, x2: 148, y2: 92 },
  { x1: 72, y1: 32, x2: 80, y2: 86 },
  { x1: 128, y1: 32, x2: 120, y2: 86 },
] as const;

/** Fills the croissant's silhouette on a canvas, `width` px wide, centred on (cx, cy). */
export function drawCroissantSilhouette(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  width: number,
): void {
  const k = width / 200;
  ctx.save();
  ctx.translate(cx - 100 * k, cy - 60 * k);
  ctx.scale(k, k);
  ctx.fillStyle = "#000";
  for (const s of CROISSANT_SEGMENTS) {
    ctx.beginPath();
    ctx.ellipse(
      s.cx,
      s.cy,
      s.rx,
      s.ry,
      (s.rot * Math.PI) / 180,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  // Thin gaps between the ridges, so ants that fill it still read as a croissant.
  ctx.globalCompositeOperation = "destination-out";
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  for (const r of RIDGES) {
    ctx.beginPath();
    ctx.moveTo(r.x1, r.y1);
    ctx.lineTo(r.x2, r.y2);
    ctx.stroke();
  }
  ctx.restore();
}
