import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><head><style>button,img { opacity: 1; }</style></head><body></body></html>",
  { url: "http://localhost" },
);
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLImageElement",
  "Element",
  "Node",
  "NodeFilter",
  "CustomEvent",
  "MutationObserver",
])
  globalThis[name] =
    name === "window"
      ? dom.window
      : name === "document"
        ? dom.window.document
        : dom.window[name];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.matchMedia = () => ({
  matches: false,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
});
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
  width: 640,
  height: 400,
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 640,
  bottom: 400,
});
const calls = [];
mock.module("@/shared/api/tauri", {
  namedExports: {
    invokeTauri: async (command, args) => {
      calls.push({ command, args });
    },
  },
});
mock.module("@/shared/theme/ThemeProvider", {
  namedExports: { useTheme: () => ({ isDark: false }) },
});
after(() => dom.window.close());
const { createElement } = await import("react");
const { render, fireEvent, cleanup, waitFor, act } = await import(
  "@testing-library/react"
);
const { ImagePreview } = await import("./ImagePreview.tsx");
const originals = [0, 1, 2].map((position) => ({
  src: `http://localhost:4545/proxy/${position}.png`,
  originalUrl: `https://relay.example/media/${position}.png`,
  alt: `Slide ${position}`,
  filename: `${position}.png`,
  width: 320,
  height: 200,
}));

test("thumbnail loads before the original, then image click opens the active ordered viewer", async () => {
  const view = render(
    createElement(ImagePreview, {
      items: [{ ...originals[0], thumbnailSrc: "/thumb.jpg" }, originals[1]],
    }),
  );
  try {
    const trigger = view.getByTestId("message-image-lightbox-trigger");
    assert.equal(trigger.querySelectorAll("img").length, 1);
    assert.equal(
      trigger.querySelector("img").getAttribute("src"),
      "/thumb.jpg",
    );
    fireEvent.load(trigger.querySelector("img"));
    assert.equal(trigger.querySelectorAll("img").length, 2);
    fireEvent.click(trigger);
    const dialog = await view.findByRole("dialog");
    assert.equal(
      dialog.querySelector("img").getAttribute("src"),
      originals[0].src,
    );
    fireEvent.click(view.getAllByRole("button", { name: "Next image" }).at(-1));
    assert.equal(
      dialog.querySelector("img").getAttribute("src"),
      originals[1].src,
    );
  } finally {
    cleanup();
  }
});

test("copy from a navigated slide sends its original URL and portals within the dialog", async () => {
  calls.length = 0;
  const view = render(createElement(ImagePreview, { items: originals }));
  try {
    fireEvent.click(view.getByRole("button", { name: "Next image" }));
    fireEvent.click(view.getByTestId("message-image-lightbox-trigger"));
    const dialog = await view.findByRole("dialog");
    fireEvent.contextMenu(dialog.querySelector("img"), {
      clientX: 20,
      clientY: 20,
    });
    const menu = dialog.querySelector("[data-image-context-menu]");
    assert.ok(menu);
    assert.equal(menu.parentElement, dialog);
    fireEvent.click(view.getByRole("button", { name: "Copy image" }));
    await waitFor(() =>
      assert.deepEqual(calls, [
        {
          command: "copy_image_to_clipboard",
          args: { url: originals[1].originalUrl },
        },
      ]),
    );
  } finally {
    cleanup();
  }
});

test("thumbnail selection keeps inactive originals unloaded and dismisses the previous menu", async () => {
  calls.length = 0;
  const view = render(createElement(ImagePreview, { items: originals }));
  try {
    const strip = view.getByTestId("media-image-thumbnails");
    const thumbnails = strip.querySelectorAll("button");
    assert.equal(thumbnails.length, 3);
    assert.deepEqual(
      [...strip.querySelectorAll("img")].map((image) =>
        image.getAttribute("src"),
      ),
      [originals[0].src],
    );
    assert.equal(thumbnails[1].querySelector("img"), null);
    assert.equal(thumbnails[2].querySelector("img"), null);
    const firstStage = view.getByTestId("message-image-lightbox-trigger");
    await act(async () => fireEvent.load(firstStage.querySelector("img")));
    fireEvent.contextMenu(firstStage.querySelector("img"));
    assert.ok(document.querySelector("[data-image-context-menu]"));
    fireEvent.click(thumbnails[1]);
    const stage = view.getByTestId("message-image-lightbox-trigger");
    assert.equal(
      stage.querySelector("img").getAttribute("src"),
      originals[1].src,
    );
    assert.equal(document.querySelector("[data-image-context-menu]"), null);
    assert.equal(thumbnails[1].getAttribute("aria-current"), "true");
    assert.equal(thumbnails[0].getAttribute("aria-current"), null);
    assert.equal(
      thumbnails[0].querySelector("img").getAttribute("src"),
      originals[0].src,
    );
    assert.equal(thumbnails[2].querySelector("img"), null);
    fireEvent.contextMenu(stage.querySelector("img"));
    fireEvent.click(view.getByRole("button", { name: "Copy image" }));
    await waitFor(() =>
      assert.deepEqual(calls, [
        {
          command: "copy_image_to_clipboard",
          args: { url: originals[1].originalUrl },
        },
      ]),
    );
  } finally {
    cleanup();
  }
});

test("thumbnail failure leaves a numbered selector and selection preserves dialog focus return", async () => {
  const view = render(
    createElement(ImagePreview, {
      items: originals.map((entry, position) => ({
        ...entry,
        thumbnailSrc: `/thumb-${position}.jpg`,
      })),
    }),
  );
  try {
    const thumbnail = view.getByRole("button", {
      name: "Show image 3 of 3: 2.png",
    });
    assert.equal(
      thumbnail.querySelector("img").getAttribute("loading"),
      "lazy",
    );
    fireEvent.error(thumbnail.querySelector("img"));
    assert.equal(thumbnail.querySelector("img"), null);
    assert.equal(thumbnail.textContent, "3");
    fireEvent.click(thumbnail);
    const expand = view.getByRole("button", { name: "Expand image" });
    fireEvent.click(expand);
    const dialog = await view.findByRole("dialog");
    assert.equal(
      dialog.querySelector("img").getAttribute("src"),
      originals[2].src,
    );
    assert.equal(
      dialog.querySelector('[data-testid="media-image-thumbnails"]'),
      null,
    );
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    await waitFor(() => assert.equal(view.queryByRole("dialog"), null));
    await waitFor(() => assert.equal(document.activeElement, expand));
  } finally {
    cleanup();
  }
});

test("hidden spoiler thumbnails cannot select images before reveal", async () => {
  const view = render(
    createElement(
      "div",
      {
        className: "buzz-spoiler",
        "data-spoiler": "",
        "data-revealed": "false",
      },
      createElement(ImagePreview, { items: originals }),
    ),
  );
  try {
    const strip = view.getByTestId("media-image-thumbnails");
    const second = strip.querySelectorAll("button")[1];
    assert.equal(second.tabIndex, -1);
    assert.equal(strip.querySelector("img"), null);
    fireEvent.click(second);
    assert.equal(view.getByTestId("media-preview-count").textContent, "1 / 3");
    await act(async () =>
      view.container.firstChild.setAttribute("data-revealed", "true"),
    );
    assert.equal(second.tabIndex, 0);
    fireEvent.click(second);
    assert.equal(view.getByTestId("media-preview-count").textContent, "2 / 3");
    assert.equal(view.queryByRole("dialog"), null);
  } finally {
    cleanup();
  }
});

for (const expanded of [false, true]) {
  test(`${expanded ? "expanded" : "inline"} keyboard navigation dismisses the previous image menu and copies the new original`, async () => {
    calls.length = 0;
    const view = render(createElement(ImagePreview, { items: originals }));
    try {
      if (expanded)
        fireEvent.click(view.getByRole("button", { name: "Expand image" }));
      const surface = expanded
        ? await view.findByRole("dialog")
        : view.getByTestId("media-image-preview");
      fireEvent.contextMenu(surface.querySelector("img"));
      assert.ok(document.querySelector("[data-image-context-menu]"));
      fireEvent.keyDown(surface, { key: "ArrowRight" });
      assert.equal(
        surface.querySelector("img").getAttribute("src"),
        originals[1].src,
      );
      assert.ok(
        !document.querySelector("[data-image-context-menu]"),
        "previous image menu should close on navigation",
      );
      fireEvent.contextMenu(surface.querySelector("img"));
      fireEvent.click(view.getByRole("button", { name: "Copy image" }));
      await waitFor(() =>
        assert.deepEqual(calls, [
          {
            command: "copy_image_to_clipboard",
            args: { url: originals[1].originalUrl },
          },
        ]),
      );
    } finally {
      cleanup();
    }
  });
}

test("repeated URLs preserve the active occurrence when opening and closing", async () => {
  const view = render(
    createElement(ImagePreview, {
      items: [originals[0], { ...originals[0], alt: "Repeated later" }],
      initialIndex: 1,
    }),
  );
  try {
    fireEvent.click(view.getByRole("button", { name: "Expand image" }));
    const dialog = await view.findByRole("dialog");
    assert.equal(
      dialog.querySelector('[data-testid="media-preview-count"]').textContent,
      "2 / 2",
    );
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    await waitFor(() => assert.equal(view.queryByRole("dialog"), null));
    assert.equal(view.getByTestId("media-preview-count").textContent, "2 / 2");
  } finally {
    cleanup();
  }
});

test("unrevealed carousel cannot open or copy and regains its trigger only after reveal", async () => {
  const view = render(
    createElement(
      "div",
      {
        className: "buzz-spoiler",
        "data-spoiler": "",
        "data-revealed": "false",
      },
      createElement(ImagePreview, { items: originals }),
    ),
  );
  try {
    const trigger = view.getByTestId("message-image-lightbox-trigger");
    assert.equal(trigger.tabIndex, -1);
    assert.equal(trigger.getAttribute("aria-hidden"), "true");
    fireEvent.click(trigger);
    fireEvent.contextMenu(trigger);
    assert.equal(view.queryByRole("dialog"), null);
    assert.equal(document.querySelector("[data-image-context-menu]"), null);
    await act(async () =>
      view.container.firstChild.setAttribute("data-revealed", "true"),
    );
    assert.equal(trigger.tabIndex, 0);
    fireEvent.click(trigger);
    assert.ok(await view.findByRole("dialog"));
  } finally {
    cleanup();
  }
});

test("same-scope discovery excludes hidden members, accepts first-frame reveals, and isolates other messages", async () => {
  const { MESSAGE_MARKDOWN_CLASS } = await import("../mentionChip.ts");
  const view = render(
    createElement(
      "div",
      null,
      createElement(
        "div",
        { className: MESSAGE_MARKDOWN_CLASS },
        createElement(ImagePreview, { items: [originals[0]] }),
        createElement(
          "div",
          {
            className: "buzz-spoiler",
            "data-spoiler": "",
            "data-revealed": "false",
          },
          createElement(ImagePreview, { items: [originals[1], originals[2]] }),
        ),
      ),
      createElement(
        "div",
        { className: MESSAGE_MARKDOWN_CLASS },
        createElement(ImagePreview, {
          items: [{ ...originals[0], alt: "Another message" }],
        }),
      ),
    ),
  );
  try {
    fireEvent.click(view.getAllByTestId("message-image-lightbox-trigger")[0]);
    let dialog = await view.findByRole("dialog");
    assert.equal(
      dialog.querySelector('[data-testid="media-preview-count"]'),
      null,
    );
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    await waitFor(() => assert.equal(view.queryByRole("dialog"), null));
    const spoiler = view.container.querySelector("[data-spoiler]");
    await act(async () => {
      spoiler.setAttribute("data-revealed", "true");
      for (const child of spoiler.querySelectorAll("*"))
        child.style.opacity = "0";
    });
    fireEvent.click(view.getAllByTestId("message-image-lightbox-trigger")[0]);
    dialog = await view.findByRole("dialog");
    assert.equal(
      dialog.querySelector('[data-testid="media-preview-count"]').textContent,
      "1 / 3",
    );
    fireEvent.click(dialog.querySelector('[aria-label="Next image"]'));
    assert.equal(
      dialog.querySelector("img").getAttribute("src"),
      originals[1].src,
    );
  } finally {
    cleanup();
  }
});
