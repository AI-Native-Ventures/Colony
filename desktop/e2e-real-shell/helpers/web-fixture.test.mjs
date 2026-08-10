import assert from "node:assert/strict";
import test from "node:test";

import { startWebFixture } from "./web-fixture.ts";

test("loopback fixture records exact text, pointer, scroll, and one action", async () => {
  const fixture = await startWebFixture();
  try {
    assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await fetch(fixture.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /COLONY CDP LOOPBACK/);

    for (const receipt of [
      {
        kind: "layout",
        input: { x: 120, y: 180 },
        action: { x: 120, y: 240 },
        scroll: { x: 120, y: 360 },
      },
      { kind: "pointer" },
      { kind: "scroll", scrollY: 240 },
      { kind: "action", value: "colony-web" },
      { kind: "visual" },
    ]) {
      const response = await fetch(new URL("receipt", fixture.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(receipt),
      });
      assert.equal(response.status, 200);
    }

    assert.deepEqual(fixture.receipts(), {
      pointerEvents: 1,
      actions: 1,
      inputValues: ["colony-web"],
      maxScrollY: 240,
      targets: {
        input: { x: 120, y: 180 },
        action: { x: 120, y: 240 },
        scroll: { x: 120, y: 360 },
      },
      visualPass: true,
      pass: true,
    });

    await fetch(new URL("receipt", fixture.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "action", value: "colony-web" }),
    });
    assert.equal(fixture.receipts().actions, 2);
    assert.equal(fixture.receipts().pass, false);
  } finally {
    await fixture.close();
  }
});
