import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import { waitForAnimations } from "../helpers/animations";

/** Where the video package reads the shots from. */
export const SHOT_DIR = fileURLToPath(
  new URL("../../../video/public/user/", import.meta.url),
);

/** A box on the screen, CSS pixels from the top left of the viewport. */
export type Box = { x: number; y: number; w: number; h: number };

type Shot = {
  file: string;
  width: number;
  height: number;
  boxes: Record<string, Box>;
};

/** The fixtures' own names, which must never share a shot with the sample business. */
const LEFTOVERS = /horizon|tyler/i;

const shots: Record<string, Shot> = {};

/**
 * Check the screen is the one the video talks about, then save it with the
 * boxes of everything the video points at. A renamed screen fails here
 * instead of shipping a stale tutorial.
 */
export async function shoot(
  page: Page,
  id: string,
  check: Locator,
  targets: Record<string, Locator> = {},
): Promise<void> {
  await expect(check).toBeVisible();
  const text = await page.locator("body").innerText();
  const leftover = LEFTOVERS.exec(text);
  if (leftover) {
    const at = leftover.index;
    throw new Error(
      `${id}: a fixture name is on screen: "${text.slice(Math.max(0, at - 80), at + 40).replace(/\s+/g, " ")}"`,
    );
  }
  await page.mouse.move(1, 1);
  await waitForAnimations(page);
  const boxes: Record<string, Box> = {};
  for (const [name, locator] of Object.entries(targets)) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    if (!box) throw new Error(`${id}: ${name} has no box on screen`);
    boxes[name] = { x: box.x, y: box.y, w: box.width, h: box.height };
  }
  mkdirSync(SHOT_DIR, { recursive: true });
  const file = `${id}.png`;
  await page.screenshot({ path: `${SHOT_DIR}${file}`, animations: "disabled" });
  const viewport = page.viewportSize();
  shots[id] = {
    file,
    width: viewport?.width ?? 0,
    height: viewport?.height ?? 0,
    boxes,
  };
}

/** Add this run's shots to the manifest, keeping shots from scenes not re-run. */
export function writeManifest(): void {
  const path = `${SHOT_DIR}manifest.json`;
  const previous = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as {
        shots?: Record<string, Shot>;
      })
    : {};
  const appCommit = execSync("git rev-parse --short HEAD").toString().trim();
  const manifest = {
    capturedAt: new Date().toISOString(),
    appCommit,
    shots: { ...(previous.shots ?? {}), ...shots },
  };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
