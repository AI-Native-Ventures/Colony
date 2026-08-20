import assert from "node:assert/strict";
import test from "node:test";

import {
  frameCoordinatesForTest,
  readWebPayloadForTest,
  webAutoStartKeyForTest,
} from "./webKind.tsx";

test("web frame coordinates map the displayed image scale to CDP pixels", () => {
  const element = {
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 400,
      height: 200,
    }),
  };

  assert.deepEqual(
    frameCoordinatesForTest(
      element,
      { clientX: 210, clientY: 70 },
      { width: 800, height: 400 },
    ),
    { x: 400, y: 100 },
  );
});

test("web payload parsing keeps the connection surface kind-scoped", () => {
  assert.deepEqual(readWebPayloadForTest({}), {
    endpoint: null,
    targetId: null,
    url: "about:blank",
  });

  assert.deepEqual(
    readWebPayloadForTest({
      endpoint: "127.0.0.1:9222",
      targetId: "target-1",
      url: "about:blank",
      binary: "/tmp/attacker-controlled-browser",
      headless: false,
    }),
    {
      endpoint: "127.0.0.1:9222",
      targetId: "target-1",
      url: "about:blank",
    },
  );
});

test("identical restored web payloads auto-start independently per tab", () => {
  const payload = {
    endpoint: null,
    targetId: null,
    url: "https://docs.example.com/same-page",
  };

  assert.notEqual(
    webAutoStartKeyForTest("tab-first", payload),
    webAutoStartKeyForTest("tab-second", payload),
  );
});
