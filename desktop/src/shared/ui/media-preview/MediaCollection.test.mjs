import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "HTMLMediaElement",
  "Element",
  "Node",
])
  globalThis[name] =
    name === "window"
      ? dom.window
      : name === "document"
        ? dom.window.document
        : dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const releases = [];
dom.window.HTMLMediaElement.prototype.pause = function () {
  releases.push({
    operation: "pause",
    player: this,
    src: this.getAttribute("src"),
  });
};
dom.window.HTMLMediaElement.prototype.load = function () {
  releases.push({
    operation: "load",
    player: this,
    src: this.getAttribute("src"),
  });
  this.currentTime = 0;
  // Simulate a reset event during teardown: it must not overwrite the saved seek.
  this.dispatchEvent(new dom.window.Event("timeupdate", { bubbles: true }));
  Object.defineProperty(this, "readyState", { configurable: true, value: 0 });
};

const React = await import("react");
const { createElement: h } = React;
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { supportsInlineFilePreview } = await import(
  "../file-preview/filePreviewModel.ts"
);
const { useFilePreviewViewState } = await import(
  "../file-preview/useFilePreviewViewState.ts"
);
const downloads = [];
const workspaceOpens = [];

function MockPlayer({ src, downloadUrl, filename, reviewKey }, tag) {
  return h(tag, {
    src,
    "data-heavy-viewer": tag,
    "data-download-url": downloadUrl,
    "data-filename": filename,
    "data-review-key": reviewKey,
  });
}

function MockDocument({
  href,
  filename,
  initialViewState,
  onViewStateChange,
  onOpenInWorkspace,
}) {
  const [state, change] = useFilePreviewViewState(
    initialViewState,
    onViewStateChange,
  );
  return h(
    "div",
    { "data-heavy-viewer": "document", "data-original-url": href },
    h(
      "output",
      { "data-testid": "document-navigation" },
      JSON.stringify(state),
    ),
    h("button", { onClick: () => change("page", state.page + 1) }, "Next page"),
    h(
      "button",
      { onClick: () => change("zoom", state.zoom + 0.25) },
      "Zoom in",
    ),
    h(
      "button",
      { onClick: () => change("sheet", state.sheet + 1) },
      "Next sheet",
    ),
    h(
      "button",
      {
        onClick: () =>
          change("rowPage", (state.rowPages[state.sheet] || 0) + 1),
      },
      "Next rows",
    ),
    h(
      "button",
      { onClick: () => downloads.push({ href, filename }) },
      "Download document",
    ),
    h("button", { onClick: onOpenInWorkspace }, "Open document"),
  );
}

mock.module("@/features/workspace/ui/WorkspaceLinkContext", {
  namedExports: {
    useWorkspaceAttachmentOpener: () => (item) => workspaceOpens.push(item),
  },
});
mock.module("../VideoPlayer.tsx", {
  namedExports: { VideoPlayer: (props) => MockPlayer(props, "video") },
});
mock.module("./AudioPlayer.tsx", {
  namedExports: { AudioPlayer: (props) => MockPlayer(props, "audio") },
});
mock.module("./ImagePreview.tsx", {
  namedExports: {
    ImagePreview: () => h("div", { "data-heavy-viewer": "image" }),
  },
});
mock.module("../file-preview/InlineFilePreview.tsx", {
  namedExports: { InlineFilePreview: MockDocument, supportsInlineFilePreview },
});
mock.module("../markdown/FileCard.tsx", {
  namedExports: {
    FileCard: ({ href, filename }) =>
      h(
        "div",
        {
          "data-heavy-viewer": "unsupported",
          "data-original-url": href,
        },
        filename,
      ),
  },
});
const { MediaCollection } = await import("./MediaCollection.tsx");
afterEach(() => {
  cleanup();
  releases.length = 0;
  downloads.length = 0;
  workspaceOpens.length = 0;
});
after(() => dom.window.close());

const entry = (filename, kind = "file", extra = {}) => ({
  item: {
    kind,
    filename,
    src: `http://localhost:4545/proxy/${filename}`,
    originalUrl: `https://relay.example/media/${filename}`,
    downloadUrl: `https://relay.example/media/${filename}`,
    ...extra,
  },
});
const select = (view, position, filename) =>
  fireEvent.click(
    view.getByRole("button", { name: `View file ${position}: ${filename}` }),
  );
const navigation = (view) =>
  JSON.parse(view.getByTestId("document-navigation").textContent);
function onlyViewer(view, kind) {
  const viewers = view.container.querySelectorAll("[data-heavy-viewer]");
  assert.equal(
    viewers.length,
    1,
    "only the selected heavyweight renderer is mounted",
  );
  assert.equal(viewers[0].getAttribute("data-heavy-viewer"), kind);
  return viewers[0];
}
function metadata(player, duration = 120) {
  Object.defineProperty(player, "readyState", { configurable: true, value: 1 });
  Object.defineProperty(player, "duration", {
    configurable: true,
    value: duration,
  });
  fireEvent.loadedMetadata(player);
}

test("switching video and audio releases the previous DOM source and restores each file after metadata", () => {
  const video = entry("launch.mp4", "video");
  const audio = entry("brief.wav", "audio");
  const view = render(h(MediaCollection, { entries: [video, audio] }));
  const firstVideo = onlyViewer(view, "video");
  assert.equal(firstVideo.getAttribute("src"), video.item.src);
  assert.equal(firstVideo.dataset.downloadUrl, video.item.originalUrl);
  const reviewKey = firstVideo.dataset.reviewKey;
  metadata(firstVideo);
  firstVideo.currentTime = 17.5;
  fireEvent.timeUpdate(firstVideo);
  select(view, 2, "brief.wav");
  const firstAudio = onlyViewer(view, "audio");
  assert.equal(firstVideo.isConnected, false);
  assert.equal(firstVideo.getAttribute("src"), null);
  assert.deepEqual(releases, [
    { operation: "pause", player: firstVideo, src: video.item.src },
    { operation: "load", player: firstVideo, src: null },
  ]);
  assert.equal(firstAudio.dataset.downloadUrl, audio.item.originalUrl);
  metadata(firstAudio);
  assert.equal(
    firstAudio.currentTime,
    0,
    "the next file must not inherit the video's position",
  );
  firstAudio.currentTime = 42;
  fireEvent.seeked(firstAudio);
  select(view, 1, "launch.mp4");
  const secondVideo = onlyViewer(view, "video");
  assert.notEqual(secondVideo, firstVideo);
  assert.equal(secondVideo.dataset.reviewKey, reviewKey);
  assert.equal(
    secondVideo.currentTime,
    0,
    "restoration waits for loaded metadata",
  );
  metadata(secondVideo);
  assert.equal(secondVideo.currentTime, 17.5);
  secondVideo.currentTime = 23;
  fireEvent.loadedMetadata(secondVideo);
  assert.equal(
    secondVideo.currentTime,
    23,
    "duplicate metadata must not undo a later seek",
  );
  select(view, 2, "brief.wav");
  const secondAudio = onlyViewer(view, "audio");
  metadata(secondAudio, 30);
  assert.equal(
    secondAudio.currentTime,
    30,
    "restore clamps the saved time to the new duration",
  );
  assert.equal(firstAudio.getAttribute("src"), null);
  assert.ok(
    releases.some(
      (event) => event.player === firstAudio && event.operation === "pause",
    ),
  );
  assert.ok(
    releases.some(
      (event) =>
        event.player === firstAudio &&
        event.operation === "load" &&
        event.src === null,
    ),
  );
  view.unmount();
  assert.equal(secondAudio.getAttribute("src"), null);
  assert.deepEqual(releases.slice(-2), [
    { operation: "pause", player: secondAudio, src: audio.item.src },
    { operation: "load", player: secondAudio, src: null },
  ]);
});

test("StrictMode effect replay preserves the active source but file switches still release it", () => {
  const video = entry("launch.mp4", "video");
  const audio = entry("brief.wav", "audio");
  const view = render(
    h(React.StrictMode, null, h(MediaCollection, { entries: [video, audio] })),
  );
  const firstVideo = onlyViewer(view, "video");
  assert.ok(
    releases.some(
      (event) => event.player === firstVideo && event.operation === "load",
    ),
    "fixture must exercise React's effect cleanup replay",
  );
  assert.equal(firstVideo.getAttribute("src"), video.item.src);
  metadata(firstVideo);
  firstVideo.currentTime = 9;
  fireEvent.timeUpdate(firstVideo);
  select(view, 2, "brief.wav");
  const firstAudio = onlyViewer(view, "audio");
  assert.equal(firstVideo.isConnected, false);
  assert.equal(firstVideo.getAttribute("src"), null);
  assert.equal(firstAudio.getAttribute("src"), audio.item.src);
  select(view, 1, "launch.mp4");
  const secondVideo = onlyViewer(view, "video");
  assert.notEqual(secondVideo, firstVideo);
  assert.equal(secondVideo.getAttribute("src"), video.item.src);
  metadata(secondVideo);
  assert.equal(
    secondVideo.currentTime,
    9,
    "cleanup timeupdate and replay must preserve the retained position",
  );
  assert.equal(firstAudio.getAttribute("src"), null);
});

test("duplicate video URLs retain independent playback positions and review identities", () => {
  const video = entry("same.mp4", "video");
  const view = render(h(MediaCollection, { entries: [video, video] }));
  const first = onlyViewer(view, "video");
  const firstReviewKey = first.dataset.reviewKey;
  metadata(first);
  first.currentTime = 12;
  fireEvent.timeUpdate(first);
  select(view, 2, "same.mp4");
  const second = onlyViewer(view, "video");
  assert.notEqual(second.dataset.reviewKey, firstReviewKey);
  metadata(second);
  assert.equal(second.currentTime, 0);
  second.currentTime = 33;
  fireEvent.timeUpdate(second);
  select(view, 1, "same.mp4");
  const restoredFirst = onlyViewer(view, "video");
  metadata(restoredFirst);
  assert.equal(restoredFirst.currentTime, 12);
  select(view, 2, "same.mp4");
  const restoredSecond = onlyViewer(view, "video");
  metadata(restoredSecond);
  assert.equal(restoredSecond.currentTime, 33);
});

test("duplicate document occurrences retain independent pages while spreadsheet sheets and row pages survive switching", () => {
  const pdf = entry("report.pdf", "file", { mime: "application/pdf" });
  const csv = entry("sales.csv", "file", { mime: "text/csv" });
  const view = render(h(MediaCollection, { entries: [pdf, pdf, csv] }));
  const firstDocument = onlyViewer(view, "document");
  fireEvent.click(view.getByRole("button", { name: "Next page" }));
  fireEvent.click(view.getByRole("button", { name: "Next page" }));
  fireEvent.click(view.getByRole("button", { name: "Zoom in" }));
  select(view, 2, "report.pdf");
  assert.equal(firstDocument.isConnected, false);
  onlyViewer(view, "document");
  assert.deepEqual(navigation(view), {
    sheet: 0,
    rowPages: {},
    page: 1,
    zoom: 1,
  });
  fireEvent.click(view.getByRole("button", { name: "Next page" }));
  select(view, 3, "sales.csv");
  onlyViewer(view, "document");
  fireEvent.click(view.getByRole("button", { name: "Next rows" }));
  fireEvent.click(view.getByRole("button", { name: "Next sheet" }));
  fireEvent.click(view.getByRole("button", { name: "Next rows" }));
  fireEvent.click(view.getByRole("button", { name: "Next rows" }));
  select(view, 1, "report.pdf");
  assert.deepEqual(navigation(view), {
    sheet: 0,
    rowPages: {},
    page: 3,
    zoom: 1.25,
  });
  select(view, 2, "report.pdf");
  assert.deepEqual(navigation(view), {
    sheet: 0,
    rowPages: {},
    page: 2,
    zoom: 1,
  });
  select(view, 3, "sales.csv");
  assert.deepEqual(navigation(view), {
    sheet: 1,
    rowPages: { 0: 1, 1: 2 },
    page: 1,
    zoom: 1,
  });
  onlyViewer(view, "document");
  assert.equal(
    view
      .getByRole("button", { name: "View file 3: sales.csv" })
      .getAttribute("aria-pressed"),
    "true",
  );
});

test("document download and workspace props use original identity, and unsupported files remain downloadable cards", () => {
  const pdf = entry("report.pdf", "file", {
    mime: "application/pdf",
    size: 123,
  });
  const docx = entry("proposal.docx", "file", {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const view = render(h(MediaCollection, { entries: [pdf, docx] }));
  const document = onlyViewer(view, "document");
  assert.equal(document.dataset.originalUrl, pdf.item.originalUrl);
  assert.notEqual(document.dataset.originalUrl, pdf.item.src);
  fireEvent.click(view.getByRole("button", { name: "Download document" }));
  fireEvent.click(view.getByRole("button", { name: "Open document" }));
  assert.deepEqual(downloads, [
    { href: pdf.item.originalUrl, filename: "report.pdf" },
  ]);
  assert.deepEqual(workspaceOpens, [
    {
      url: pdf.item.originalUrl,
      filename: "report.pdf",
      mime: "application/pdf",
    },
  ]);
  select(view, 2, "proposal.docx");
  const unsupported = onlyViewer(view, "unsupported");
  assert.equal(document.isConnected, false);
  assert.equal(unsupported.dataset.originalUrl, docx.item.originalUrl);
  assert.equal(unsupported.textContent, "proposal.docx");
});

test("unavailable entries keep their positions without mounting a viewer or becoming selectors", () => {
  const audio = entry("brief.wav", "audio");
  const pdf = entry("report.pdf", "file");
  const unavailable = { reason: "Attachment is unavailable." };
  const view = render(
    h(MediaCollection, { entries: [unavailable, audio, unavailable, pdf] }),
  );
  onlyViewer(view, "audio");
  const rows = view.getAllByRole("status");
  assert.deepEqual(
    rows.map((row) => row.textContent),
    [
      "Item 1: Attachment is unavailable.",
      "Item 3: Attachment is unavailable.",
    ],
  );
  const buttons = view
    .getByRole("group", { name: "Choose a file" })
    .querySelectorAll("button");
  assert.deepEqual(
    [...buttons].map((button) => button.getAttribute("aria-label")),
    ["View file 2: brief.wav", "View file 4: report.pdf"],
  );
  fireEvent.click(rows[0]);
  onlyViewer(view, "audio");
  select(view, 4, "report.pdf");
  onlyViewer(view, "document");
  view.rerender(h(MediaCollection, { entries: [unavailable, audio] }));
  onlyViewer(view, "audio");
  view.rerender(h(MediaCollection, { entries: [unavailable, unavailable] }));
  assert.equal(
    view.container.querySelectorAll("[data-heavy-viewer]").length,
    0,
  );
  assert.equal(view.queryAllByRole("button").length, 0);
  assert.equal(view.getAllByRole("status").length, 2);
});
