import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoReviewPosterPreview } from "../VideoReviewPosterPreview.tsx";
import { AudioPlayer } from "./AudioPlayer.tsx";
import { ImagePreview } from "./ImagePreview.tsx";
const render = (component, props) =>
  renderToStaticMarkup(React.createElement(component, props));
const items = [
  {
    src: "/rich-previews/launch-01.svg",
    alt: "Square artwork",
    width: 1080,
    height: 1080,
  },
  {
    src: "/rich-previews/launch-02.svg",
    alt: "Portrait artwork",
    width: 900,
    height: 1200,
  },
  {
    src: "/rich-previews/launch-03.svg",
    alt: "Landscape artwork",
    width: 1440,
    height: 900,
  },
];
test("a collection loads only the active original and presents ordered navigation", () => {
  const html = render(ImagePreview, { items, initialIndex: 1 });
  const stage =
    html.match(
      /<button[^>]+data-image-lightbox-trigger[^>]*>.*?<\/button>/s,
    )?.[0] || "";
  assert.equal((stage.match(/<img /g) ?? []).length, 1);
  assert.match(stage, /src="\/rich-previews\/launch-02.svg"/);
  assert.match(stage, /object-contain/);
  assert.doesNotMatch(html, /src="\/rich-previews\/launch-0[13].svg"/);
  assert.match(html, /2 \/ 3/);
  assert.match(html, /aria-label="Previous image"/);
  assert.match(html, /aria-label="Next image"/);
  assert.match(html, /aria-label="Expand image"/);
  assert.doesNotMatch(stage, /object-cover/);
  assert.match(html, /aria-label="Choose an image"/);
  assert.match(
    html,
    /aria-label="Show image 2 of 3: Portrait artwork" aria-current="true"/,
  );
});
test("a single portrait reserves its authored ratio without carousel chrome", () => {
  const html = render(ImagePreview, { items: [items[1]] });
  assert.match(html, /aspect-ratio:0.75/);
  assert.doesNotMatch(html, /Previous image|Next image/);
  assert.doesNotMatch(html, /media-image-thumbnails|Show image/);
});

test("thumbnail strip uses supplied lazy thumbnails without loading inactive originals", () => {
  const html = render(ImagePreview, {
    items: items.map((item, position) => ({
      ...item,
      thumbnailSrc: `/thumb-${position}.jpg`,
    })),
  });
  const strip =
    html.match(
      /<fieldset[^>]+data-testid="media-image-thumbnails"[^>]*>.*?<\/fieldset>/s,
    )?.[0] || "";
  assert.equal((strip.match(/<button /g) ?? []).length, 3);
  assert.equal((strip.match(/loading="lazy"/g) ?? []).length, 3);
  for (let position = 0; position < 3; position++)
    assert.ok(strip.includes(`src="/thumb-${position}.jpg"`));
  assert.doesNotMatch(strip, /src="\/rich-previews\//);
  assert.match(strip, /overflow-x-auto/);
});

test("single-image source dimensions reach the image before decoding without display caps", () => {
  const html = render(ImagePreview, {
    items: [
      {
        src: "https://relay.test/media/wide.png",
        alt: "Wide screenshot",
        width: 951,
        height: 244,
      },
    ],
  });
  const image = html.match(/<img [^>]+>/)?.[0] || "";
  assert.match(image, /width="951"/);
  assert.match(image, /height="244"/);
  assert.match(image, /h-full w-full .*object-contain/);
  assert.match(html, new RegExp(`aspect-ratio:${951 / 244}`));
  assert.doesNotMatch(html, /max-h-|max-w-\[/);
});
test("audio remains phrasing content and never starts automatically", () => {
  const html = render(AudioPlayer, {
    src: "/rich-previews/preview-audio.wav",
    filename: "Briefing.wav",
  });
  assert.match(html, /^<span /);
  assert.match(html, /preload="metadata"/);
  assert.match(html, /aria-label="Play audio"/);
  assert.match(html, /aria-label="Seek audio"[^>]*disabled/);
  assert.match(html, /0:00 \/ —/);
  assert.doesNotMatch(html, /autoPlay|autoplay|<div|waveform/i);
});
test("a missing video poster has an informative themed cover", () => {
  const html = render(VideoReviewPosterPreview, {
    visible: true,
    filename: "Launch.mp4",
  });
  assert.match(html, /data-testid="video-poster-surface"/);
  assert.match(html, /Launch.mp4/);
  assert.match(html, /Play to view video/);
  assert.match(html, /bg-muted/);
  assert.doesNotMatch(html, /<img /);
});
test("video cover hides for playback and keeps supplied poster separate from video seeking", () => {
  assert.equal(
    render(VideoReviewPosterPreview, { visible: false, poster: "/poster.jpg" }),
    "",
  );
  const html = render(VideoReviewPosterPreview, {
    visible: true,
    poster: "/poster.jpg",
  });
  assert.match(html, /src="\/poster.jpg"/);
  assert.doesNotMatch(html, /crossorigin|<video/);
});

test("bundled samples download their original SVG while relay media retains native saving", () => {
  const bundled = render(ImagePreview, {
    items: [
      { ...items[0], filename: "launch-01.svg", downloadUrl: items[0].src },
    ],
  });
  assert.match(
    bundled,
    /<a download="launch-01.svg" href="\/rich-previews\/launch-01.svg"/,
  );
  const relay = render(ImagePreview, {
    items: [
      {
        ...items[0],
        downloadUrl: "https://relay.example/media/original.svg",
        filename: "original.svg",
      },
    ],
  });
  assert.match(relay, /aria-label="Download original.svg"/);
  assert.doesNotMatch(relay, /<a download/);
});
