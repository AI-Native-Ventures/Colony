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

/** A target measured around its words alone, for a cell much wider than its text. */
export type Words = { words: Locator };

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
  targets: Record<string, Locator | Words> = {},
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
  for (const [name, target] of Object.entries(targets)) {
    const locator = "words" in target ? target.words : target;
    await expect(locator).toBeVisible();
    const box =
      "words" in target ? await wordsBox(locator) : await locator.boundingBox();
    if (!box) throw new Error(`${id}: ${name} has no box on screen`);
    const view = page.viewportSize() ?? { width: 0, height: 0 };
    if (
      box.x < 0 ||
      box.y < 0 ||
      box.x + box.width > view.width ||
      box.y + box.height > view.height
    )
      throw new Error(`${id}: ${name} is not wholly on screen`);
    const cover = await coveredAt(locator);
    if (cover) throw new Error(`${id}: ${name} is covered at ${cover}`);
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

/** The box around an element's words, rather than the element. */
async function wordsBox(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    return r.width > 0
      ? { x: r.x, y: r.y, width: r.width, height: r.height }
      : null;
  });
}

/**
 * Where something else sits on top of the target (its middle and near each
 * corner), or null when nothing does. A box inside the viewport can still be
 * hidden under the composer or a pill.
 */
async function coveredAt(locator: Locator): Promise<string | null> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const inset = Math.min(12, r.width / 4, r.height / 4);
    const points = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + inset, r.top + inset],
      [r.right - inset, r.top + inset],
      [r.left + inset, r.bottom - inset],
      [r.right - inset, r.bottom - inset],
    ];
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      if (hit && !el.contains(hit) && !hit.contains(el)) {
        const testId = hit
          .closest("[data-testid]")
          ?.getAttribute("data-testid");
        return `${Math.round(x)},${Math.round(y)} by ${hit.tagName.toLowerCase()}${testId ? ` in [data-testid="${testId}"]` : ""}`;
      }
    }
    return null;
  });
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
