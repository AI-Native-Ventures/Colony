/**
 * The real app's screens for the user videos, captured by the desktop's
 * `pnpm capture:user-videos` into `public/user/manifest.json`.
 */

/** Every shot the user videos use, and the boxes each must carry. */
export const SHOT_BOXES = {
  "account-empty": ["name"],
  account: ["create", "email", "name", "password"],
  recovery: ["code", "save"],
  "business-empty": ["name", "website"],
  "business-filled": ["name", "read", "website"],
  "business-read": ["continue", "name", "read", "summary", "website"],
  "power-credits": ["credits", "free", "subscriptions"],
  "power-subscriptions": ["list", "subscriptions"],
  "power-test": ["model", "test"],
  "power-replied": ["continue", "replied"],
  history: ["choose", "dialog", "skip"],
  "welcome-routes": ["deciding", "existing", "new", "question"],
  "welcome-confirm": ["details", "yes"],
  "welcome-priority": ["customers", "delivery", "next", "other"],
  understanding: ["looksRight", "nothingYet", "still"],
  setup: ["approve", "keep"],
  "find-clients": ["brief", "examples", "findClients", "outputs"],
  "first-job": ["brief", "examples", "outputs", "start"],
  "first-job-started": ["status"],
  "job-thread": ["drafts", "title"],
  "outreach-card": ["approve", "card"],
  "outreach-sent": ["card", "from", "status"],
} as const satisfies Record<string, readonly string[]>;

export type ShotId = keyof typeof SHOT_BOXES;
export const SHOT_IDS = Object.keys(SHOT_BOXES) as ShotId[];

/** A box on a shot, in the app's CSS pixels from the top left. */
export type Box = { x: number; y: number; w: number; h: number };
export type Shot = {
  file: string;
  width: number;
  height: number;
  boxes: Record<string, Box>;
};
export type Manifest = {
  capturedAt: string;
  appCommit: string;
  shots: Record<ShotId, Shot>;
};

/** The app window size the capture runs at, CSS pixels. */
export const APP_VIEWPORT = { w: 1440, h: 900 } as const;

/** Shots taken in a narrower window, so their words are larger once cropped (and taller, so the email fits above the composer). */
const NARROW: Partial<Record<ShotId, { w: number; h: number }>> = {
  "outreach-card": { w: 1080, h: 1200 },
  "outreach-sent": { w: 1080, h: 1200 },
};

/** The window size a shot is taken at, CSS pixels. */
export function viewportOf(id: ShotId): { w: number; h: number } {
  return NARROW[id] ?? APP_VIEWPORT;
}

/** The manifest, or an error that names every missing shot and box. */
export function checkManifest(raw: unknown): Manifest {
  const shots =
    (raw as { shots?: Record<string, Partial<Shot>> } | null)?.shots ?? {};
  const problems: string[] = [];
  for (const id of SHOT_IDS) {
    const shot = shots[id];
    if (!shot) {
      problems.push(`${id}: missing`);
      continue;
    }
    const size = viewportOf(id);
    if (shot.width !== size.w || shot.height !== size.h)
      problems.push(
        `${id}: ${shot.width} x ${shot.height}, expected ${size.w} x ${size.h}`,
      );
    for (const name of SHOT_BOXES[id])
      if (!shot.boxes?.[name]) problems.push(`${id}: no box "${name}"`);
  }
  if (problems.length > 0)
    throw new Error(
      `Re-capture the user video shots (desktop: pnpm capture:user-videos):\n${problems.join("\n")}`,
    );
  return raw as Manifest;
}

/** The smallest box around all of `boxes`. */
export function unionBox(boxes: readonly Box[]): Box {
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}
