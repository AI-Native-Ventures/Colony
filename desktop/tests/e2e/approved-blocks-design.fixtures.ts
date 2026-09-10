import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { waitForAnimations } from "../helpers/animations";
import { seedActiveIdentity } from "../helpers/onboarding";
import { TEST_IDENTITIES } from "../helpers/bridge";
import type { ManifestFixture } from "./blocks-test-helpers";
import {
  validateBlockData,
  validateBlockManifest,
} from "../../src/features/blocks/blockValidation";

const relaySource = readFileSync(
  new URL("../../../crates/buzz-relay/src/core_blocks.rs", import.meta.url),
  "utf8",
);
/** Discover the actual relay bundle, excluding retained legacy manifests. */
export const approvedCoreManifests = [
  ...relaySource.matchAll(
    /include_str!\("(core_blocks\/(?:primitives|composites)\/[^"\n]+\.json)"\)/g,
  ),
].map((match) => {
  const source = match[1];
  const bytes = readFileSync(
    new URL(`../../../crates/buzz-relay/src/${source}`, import.meta.url),
  );
  return {
    source,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    manifest: JSON.parse(bytes.toString()) as ManifestFixture,
  };
});

export type ApprovedTheme = "buzz" | "buzz-dark";

/** Exercise the production contract before creating signed browser fixtures. */
export function assertApprovedFixture(manifest: ManifestFixture) {
  const parsed = validateBlockManifest(manifest);
  expect(parsed.ok, parsed.ok ? "valid manifest" : parsed.message).toBe(true);
  if (!parsed.ok) return;
  const data = validateBlockData(
    parsed.value,
    manifest.examples[0]?.data ?? {},
  );
  expect(data.ok, data.ok ? "valid example" : data.message).toBe(true);
}

/** Seed appearance before bridge mount; use the real right-hand thread. */
export async function seedApprovedAppearance(page: Page, theme: ApprovedTheme) {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await page.addInitScript((value) => {
    localStorage.setItem("buzz-theme", value);
    localStorage.setItem("buzz-follow-system", "false");
    localStorage.setItem("buzz-accent-color", "#895AF6");
    localStorage.setItem("buzz.channels.threadViewMode", "split");
    sessionStorage.setItem("buzz.desktop.thread-panel-width", "400");
  }, theme);
}

/** Source examples use illustrative remote URLs; only their media bytes are local fixtures. */
export async function installApprovedExampleMedia(page: Page) {
  await page.route(/^https:\/\/(?:example\.com|assets\.example)\//, (route) =>
    route.fulfill({
      body: readFileSync(
        new URL("../../public/rich-previews/launch-01.svg", import.meta.url),
      ),
      contentType: "image/svg+xml",
      headers: {
        "content-security-policy": "default-src 'none'",
        "x-content-type-options": "nosniff",
      },
    }),
  );
}

/** A real native tree must replace the fallback and contain readable or decoded content. */
export async function expectApprovedBlock(block: Locator) {
  await expect(block).toBeVisible();
  await expect(block).toHaveAttribute("data-block-trust", "core");
  await expect(block.locator("[data-block-fallback]")).toHaveCount(0);
  await expect(block).not.toContainText(
    /This inline view could not be verified|Unsupported primitive|Image preview unavailable|Media source unavailable/,
  );
  expect(await block.locator("[data-block-primitive]").count()).toBeGreaterThan(
    0,
  );
  expect((await block.innerText()).trim().length).toBeGreaterThan(0);
  for (const image of await block
    .locator("[data-testid='message-image-lightbox-trigger'] img")
    .all()) {
    await expect(image).toHaveJSProperty("complete", true);
    await expect
      .poll(() =>
        image.evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
  }
  expect(
    await block.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
}

/** Capture the full subject after animation, without clipping tall narrow-thread content. */
export async function captureApproved(
  page: Page,
  subject: Locator,
  info: TestInfo,
  filename: string,
) {
  await subject.scrollIntoViewIfNeeded();
  const box = await subject.boundingBox();
  if (!box) throw new Error(`Missing capture surface: ${filename}`);
  const viewport = page.viewportSize();
  if (viewport && box.height > viewport.height - 240) {
    await page.setViewportSize({
      width: viewport.width,
      height: Math.min(5000, Math.ceil(box.height + 300)),
    });
    await subject.scrollIntoViewIfNeeded();
  }
  await waitForAnimations(page);
  const bytes = await subject.screenshot({ path: info.outputPath(filename) });
  return {
    filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    box: await subject.boundingBox(),
  };
}

/** Use the normal focusable reply action, centred clear of timeline overlays. */
export async function openApprovedThread(page: Page, row: Locator) {
  await row.hover();
  const reply = row.getByRole("button", { name: "Reply", exact: true });
  await reply.focus();
  await reply.evaluate((button) =>
    button.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "instant",
    }),
  );
  await reply.click();
  return page.getByTestId("message-thread-head");
}
