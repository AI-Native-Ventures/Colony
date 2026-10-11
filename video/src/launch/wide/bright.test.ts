import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GEYSER_PRICE,
  PAGE_H,
  PAINT_Y,
  SITE_BANDS,
  SITE_BAR,
  SITE_CARD,
  SITE_SERVICES,
} from "./bright.ts";

test("the new page's bands stack top to bottom and fill the page", () => {
  const bands = Object.values(SITE_BANDS);
  assert.equal(bands[0].top, 0);
  for (let i = 1; i < bands.length; i++) {
    assert.equal(bands[i].top, bands[i - 1].bottom);
  }
  assert.equal(bands[bands.length - 1].bottom, PAGE_H);
});

test("the painter walks inside the bottom band, clear of the service cards", () => {
  const feet = PAINT_Y - SITE_CARD.y - SITE_BAR;
  assert.ok(feet >= SITE_BANDS.cta.top + 16, `feet at ${feet}`);
  assert.ok(feet <= SITE_BANDS.cta.bottom - 16, `feet at ${feet}`);
});

test("every service has a price, and the geyser price matches the post", () => {
  for (const s of SITE_SERVICES) assert.match(s.price, /^From R\d+$/);
  const geyser = SITE_SERVICES.find((s) => s.icon === "geyser");
  assert.equal(geyser?.price, `From ${GEYSER_PRICE}`);
});
