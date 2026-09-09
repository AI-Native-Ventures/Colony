import assert from "node:assert/strict";
import test from "node:test";
import { DesktopDeepLinks } from "./deep-links.mjs";

test("OS deep links wait for startup and exclude non-app navigation", () => {
  const queue = new DesktopDeepLinks();
  const received = [];
  queue.enqueue("buzz://message?channel=fixture&id=123");
  queue.enqueue("buzz://message?channel=fixture&id=123");
  queue.enqueue("javascript:alert(1)");
  queue.enqueue("file:///etc/passwd");
  queue.enqueue("buzz://user:password@join");
  queue.ready((url) => received.push(url));
  queue.enqueue("buzz://join?relay=wss%3A%2F%2Ffixture.invalid");
  assert.deepEqual(received, [
    "buzz://message?channel=fixture&id=123",
    "buzz://join?relay=wss%3A%2F%2Ffixture.invalid",
  ]);
});
