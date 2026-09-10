import assert from "node:assert/strict";
import { test } from "node:test";

import { createHost, createWindow, requestFor } from "./host-test-support.mjs";

test("clip opt-in preserves the CSS viewport without rescaling", async () => {
  const { host, world } = createHost({ clipStrategy: "clip" });
  const window = createWindow();
  const state = await host.open(requestFor(window));
  const view = world.views[0];
  const container = window.contentView.children[0];

  host.updateBounds({
    window,
    handle: state.handle,
    bounds: { x: 100, y: 50, width: 720, height: 450 },
    clip: null,
    zoom: 1,
    radius: 8,
  });
  assert.deepEqual(container.bounds, {
    x: 100,
    y: 50,
    width: 720,
    height: 450,
  });
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 720, height: 450 });
  assert.equal(view.webContents.zoomFactor, 0.5);
  assert.equal(container.borderRadius, 8);

  host.setVisible({ window, handle: state.handle, visible: true });
  assert.equal(container.visible, true);
  assert.equal(view.visible, true);

  // Scrolling under a header clips the container, not the page scale.
  host.updateBounds({
    window,
    handle: state.handle,
    bounds: { x: 100, y: 50, width: 720, height: 450 },
    clip: { top: 0, left: 0, right: 2000, bottom: 150 },
    zoom: 1,
  });
  assert.deepEqual(container.bounds, {
    x: 100,
    y: 50,
    width: 720,
    height: 100,
  });
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 720, height: 450 });
  assert.equal(view.webContents.zoomFactor, 0.5);
  assert.equal(container.visible, true);

  // Fully occluded: hidden, geometry kept for the next update.
  host.updateBounds({
    window,
    handle: state.handle,
    bounds: { x: 100, y: 50, width: 720, height: 450 },
    clip: { top: 600, left: 0, right: 2000, bottom: 900 },
    zoom: 1,
  });
  assert.equal(container.visible, false);
  assert.equal(view.visible, false);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 720, height: 450 });

  // Application zoom converts CSS bounds into content pixels.
  host.updateBounds({
    window,
    handle: state.handle,
    bounds: { x: 50, y: 25, width: 720, height: 450 },
    clip: null,
    zoom: 2,
  });
  assert.deepEqual(container.bounds, {
    x: 100,
    y: 50,
    width: 1440,
    height: 900,
  });
  assert.equal(view.webContents.zoomFactor, 1);

  // Mobile keeps the 390x844 CSS viewport, fitted without cropping. The
  // integer-rounded height means the CSS viewport is 844 CSS px within
  // rounding: assert the honest tolerance, not an exact height.
  const mobile = await host.open(
    requestFor(window, {
      jobId: "job-mobile",
      viewport: "mobile",
      pixelWidth: 390,
      pixelHeight: 844,
    }),
  );
  host.updateBounds({
    window,
    handle: mobile.handle,
    bounds: { x: 0, y: 0, width: 300, height: 844 },
    clip: null,
    zoom: 1,
  });
  const mobileView = world.views[1];
  assert.equal(mobileView.bounds.width, 300);
  assert.equal(mobileView.bounds.height, Math.round((844 * 300) / 390));
  assert.equal(mobileView.webContents.zoomFactor, 300 / 390);
  const cssHeight = mobileView.bounds.height / mobileView.webContents.zoomFactor;
  assert.ok(Math.abs(cssHeight - 844) <= 1, `css height ${cssHeight}`);
});

test("the default hide strategy hides a partially occluded pane", async () => {
  const { host, world } = createHost();
  const window = createWindow();
  const state = await host.open(requestFor(window));
  const view = world.views[0];
  host.setVisible({ window, handle: state.handle, visible: true });

  host.updateBounds({
    window,
    handle: state.handle,
    bounds: { x: 0, y: 0, width: 720, height: 450 },
    clip: null,
    zoom: 1,
  });
  assert.equal(view.visible, true);

  host.updateBounds({
    window,
    handle: state.handle,
    bounds: { x: 0, y: 0, width: 720, height: 450 },
    clip: { top: 0, left: 0, right: 2000, bottom: 150 },
    zoom: 1,
  });
  assert.equal(view.visible, false);

  host.updateBounds({
    window,
    handle: state.handle,
    bounds: { x: 0, y: 0, width: 720, height: 450 },
    clip: { top: 0, left: 0, right: 2000, bottom: 900 },
    zoom: 1,
  });
  assert.equal(view.visible, true);
});

test("invalid bounds, clip, and zoom are refused", async () => {
  const { host } = createHost();
  const window = createWindow();
  const state = await host.open(requestFor(window));
  const bounds = { x: 0, y: 0, width: 100, height: 100 };
  assert.throws(
    () =>
      host.updateBounds({
        window,
        handle: state.handle,
        bounds: { x: 0, y: 0, width: Number.NaN, height: 10 },
      }),
    (error) => error?.code === "invalid_bounds",
  );
  assert.throws(
    () =>
      host.updateBounds({
        window,
        handle: state.handle,
        bounds,
        clip: { top: 0, left: 0, right: Number.POSITIVE_INFINITY, bottom: 1 },
      }),
    (error) => error?.code === "invalid_clip",
  );
  assert.throws(
    () => host.updateBounds({ window, handle: state.handle, bounds, zoom: 0 }),
    (error) => error?.code === "invalid_zoom",
  );
  assert.throws(
    () => host.updateBounds({ window, handle: "", bounds }),
    (error) => error?.code === "invalid_request",
  );
});
