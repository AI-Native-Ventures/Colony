import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { FileCard } from "./FileCard.tsx";
import { MarkdownMediaParagraph } from "./MediaPreview.tsx";
import { MarkdownRuntimeContext } from "./runtimeContext.ts";

const runtime = {
  channels: [],
  onOpenChannel() {},
  onOpenEntityLink() {},
  onOpenMessageLink() {},
  relayOrigin: null,
};

test("actual Markdown image children route to one carousel in supplied order", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        components: {
          p: MarkdownMediaParagraph,
          img: ({ node: _node, ...props }) => React.createElement("img", props),
        },
      },
      "![First](/rich-previews/launch-01.svg)\n![Second](/rich-previews/launch-02.svg)",
    ),
  );
  assert.equal(
    (html.match(/data-testid="media-image-preview"/g) ?? []).length,
    1,
  );
  assert.equal((html.match(/<img /g) ?? []).length, 1);
  assert.match(html, /src="\/rich-previews\/launch-01.svg"/);
  assert.match(html, /1 \/ 2/);
});

test("actual document FileCard in a Markdown paragraph receives a block parent", () => {
  const href = "https://relay.example/media/report.pdf";
  const imetaByUrl = new Map([
    [href, { m: "application/pdf", filename: "report.pdf", size: 100 }],
  ]);
  const html = renderToStaticMarkup(
    React.createElement(
      MarkdownRuntimeContext.Provider,
      {
        value: { ...runtime, imetaByUrl },
      },
      React.createElement(
        ReactMarkdown,
        {
          components: {
            p: MarkdownMediaParagraph,
            a: () =>
              React.createElement(FileCard, {
                href,
                filename: "report.pdf",
                mime: "application/pdf",
                size: 100,
              }),
          },
        },
        "Read [report.pdf](https://relay.example/media/report.pdf) here.",
      ),
    ),
  );
  assert.match(html, /^<div>Read /);
  assert.match(html, /data-testid="inline-file-preview"/);
  assert.doesNotMatch(html, /<p>Read /);
});

test("Markdown image metadata reaches the carousel image before the bytes load", () => {
  const src = "https://relay.example/media/wide.png";
  const html = renderToStaticMarkup(
    React.createElement(
      MarkdownRuntimeContext.Provider,
      {
        value: {
          ...runtime,
          imetaByUrl: new Map([[src, { m: "image/png", dim: "951x244" }]]),
        },
      },
      React.createElement(
        ReactMarkdown,
        {
          components: {
            p: MarkdownMediaParagraph,
            img: ({ node: _node, ...props }) =>
              React.createElement("img", props),
          },
        },
        `![Wide screenshot](${src})\n![Second](/rich-previews/launch-02.svg)`,
      ),
    ),
  );
  const image = html.match(/<img [^>]+>/)?.[0] || "";
  assert.match(image, /width="951"/);
  assert.match(image, /height="244"/);
  assert.match(html, /aria-roledescription="carousel"/);
});
