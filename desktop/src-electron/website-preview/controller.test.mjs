import assert from "node:assert/strict";
import { test } from "node:test";
import { PreviewController } from "./controller.mjs";

function setup(open = async () => ({ handle: "h" })) {
  const calls = [];
  const community = { id: "community" };
  const host = {
    open,
    invalidateAll: async () => calls.push("reset"),
    close: async ({ handle }) => calls.push(handle),
    updateBounds: (value) => value,
  };
  return { calls, controller: new PreviewController({ host, window: {}, context: () => community }) };
}

test("rejects another community and unknown handles before touching the host", async () => {
  const { controller } = setup(() => assert.fail("must not open"));
  await assert.rejects(controller.request("open", { communityId: "other" }), /community/);
  await assert.rejects(controller.request("bounds", { communityId: "community", handle: "h" }), /no longer active/);
});

test("reset revokes previously issued handles", async () => {
  const { controller } = setup();
  await controller.request("open", { communityId: "community" });
  await controller.reset();
  await assert.rejects(controller.request("bounds", { communityId: "community", handle: "h" }), /no longer active/);
});

test("an in-flight open cannot survive a renderer reset", async () => {
  let finish;
  const { controller, calls } = setup(() => new Promise((resolve) => { finish = resolve; }));
  const pending = controller.request("open", { communityId: "community" });
  await controller.reset();
  finish({ handle: "stale" });
  await assert.rejects(pending, /context changed/);
  assert.deepEqual(calls, ["reset", "stale"]);
});

test("two cards for the same artifact receive separate native mounts", async () => {
  const mounts = [];
  const { controller } = setup(async (request) => {
    mounts.push(request.mountId);
    return { handle: request.mountId };
  });
  const payload = { communityId: "community", artifactId: "a".repeat(64) };
  const channel = await controller.request("open", payload);
  const thread = await controller.request("open", payload);
  assert.notEqual(mounts[0], mounts[1]);
  await controller.request("close", { ...payload, handle: channel.handle });
  await assert.rejects(controller.request("bounds", { ...payload, handle: channel.handle }), /no longer active/);
  const remaining = await controller.request("bounds", { ...payload, handle: thread.handle });
  assert.equal(remaining.handle, thread.handle);
});
