import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { Schema } from "@tiptap/pm/model";
import { AllSelection, EditorState, TextSelection } from "@tiptap/pm/state";

import {
  createComposerLinkPasteHandler,
  registerComposerMessageLinkMarkdownIt,
  resolveComposerMessageLinkAttributes,
  resolveExactLinkPaste,
  resolveSelectionLinkPaste,
} from "./composerMessageLinkNode.ts";

const requireFromTiptap = createRequire(import.meta.resolve("tiptap-markdown"));
const MarkdownIt = requireFromTiptap("markdown-it");

const CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const MESSAGE_ID = "root-event";
const HREF = `buzz://message?channel=${CHANNEL_ID}&id=${MESSAGE_ID}`;

test("resolves a composer preview and canonicalizes the underlying href", () => {
  assert.deepEqual(
    resolveComposerMessageLinkAttributes(
      HREF.replace("buzz://", "BUZZ://"),
      (channelId) => (channelId === CHANNEL_ID ? "general" : undefined),
    ),
    { channelName: "general", href: HREF },
  );
});

test("rejects malformed message links", () => {
  assert.equal(
    resolveComposerMessageLinkAttributes(
      `buzz://message?channel=${CHANNEL_ID}`,
      () => "general",
    ),
    null,
  );
});

const resolveKnownChannel = (channelId) =>
  channelId === CHANNEL_ID ? "general" : undefined;
const exactLinkPaste = (text) =>
  resolveExactLinkPaste(text, resolveKnownChannel);

const EXACT_LINK_PASTE_ACCEPTED_CASES = [
  ["exact http", "https://example.com", "https://example.com"],
  [
    "wrapped http",
    "<https://example.com/docs?q=1>",
    "https://example.com/docs?q=1",
  ],
  ["exact message", HREF, HREF],
  ["wrapped message", `<${HREF}>`, HREF],
];

for (const [label, input, expectedHref] of EXACT_LINK_PASTE_ACCEPTED_CASES) {
  test(`exact link paste resolves ${label}`, () => {
    assert.deepEqual(exactLinkPaste(input), { href: expectedHref });
  });
}

for (const input of [
  "https://example.com and words",
  " https://example.com",
  "https://example.com ",
  "https://example.com\n",
  "<https://example.com> trailing",
  "www.example.com",
  "ftp://example.com",
  "not a url",
  `See ${HREF}`,
  `buzz://channel/${CHANNEL_ID}/not-a-message-id`,
]) {
  test(`exact link paste rejects ${input}`, () => {
    assert.equal(exactLinkPaste(input), null);
  });
}

// The selection branch is the composer's alone now that `linkOnPaste` is off,
// so it has to accept everything linkify accepted — otherwise turning the
// second handler off would silently narrow which URLs preserve their label.
for (const [label, input, expectedHref] of [
  ["exact http", "https://example.com", "https://example.com"],
  ["wrapped http", "<https://example.com>", "https://example.com"],
  ["canonical Buzz link", HREF, HREF],
  ["scheme-less host", "www.example.com", "http://www.example.com"],
  ["bare host with path", "example.com/docs", "http://example.com/docs"],
  ["email address", "foo@example.com", "mailto:foo@example.com"],
  ["ftp", "ftp://example.com", "ftp://example.com"],
]) {
  test(`selection link paste resolves ${label}`, () => {
    assert.deepEqual(resolveSelectionLinkPaste(input, resolveKnownChannel), {
      href: expectedHref,
    });
  });
}

for (const input of [
  "https://example.com and words",
  " https://example.com",
  "read this",
  "",
]) {
  test(`selection link paste rejects ${JSON.stringify(input)}`, () => {
    assert.equal(resolveSelectionLinkPaste(input, resolveKnownChannel), null);
  });
}

const editorSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    composerMessageLink: {
      atom: true,
      attrs: { channelName: { default: "" }, href: { default: "" } },
      group: "inline",
      inline: true,
      selectable: true,
    },
    codeBlock: { content: "text*", group: "block", marks: "" },
  },
  marks: {
    // `excludes: "_"` mirrors StarterKit's `code` mark: it silently drops any
    // other mark added over it, so a link applied to code-marked text never
    // lands even though the parent paragraph allows link marks.
    code: { excludes: "_" },
    link: { attrs: { href: {} }, inclusive: false },
  },
});

const paragraph = (...content) =>
  editorSchema.nodes.paragraph.create(null, content);
const codeBlock = (...content) =>
  editorSchema.nodes.codeBlock.create(null, content);
const document = (...content) => editorSchema.nodes.doc.create(null, content);
const text = (value, marks = []) => editorSchema.text(value, marks);
const composerChip = (href = HREF) =>
  editorSchema.nodes.composerMessageLink.create({
    channelName: "general",
    href,
  });

function createPasteEvent(value) {
  let prevented = false;
  return {
    clipboardData: { getData: (type) => (type === "text/plain" ? value : "") },
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
}

function createMockView(state) {
  const view = {
    dispatch(transaction) {
      view.state = view.state.apply(transaction);
    },
    focusCalled: false,
    focus() {
      view.focusCalled = true;
    },
    state,
  };
  return view;
}

function stateFromDocument(doc, from, to = from) {
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, to),
  });
}

function allSelectionStateFromDocument(doc) {
  return EditorState.create({
    doc,
    selection: new AllSelection(doc),
  });
}

function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

test("paste handler links selected text instead of replacing it", () => {
  const doc = document(paragraph(text("read this")));
  const view = createMockView(stateFromDocument(doc, 1, 10));
  const event = createPasteEvent("https://example.com");
  const handled = createComposerLinkPasteHandler(resolveKnownChannel)(
    view,
    event,
  );

  assert.equal(handled, true);
  assert.equal(event.defaultPrevented, true);
  assert.equal(view.focusCalled, true);
  assert.equal(view.state.doc.textContent, "read this");
  assert.deepEqual(toPlainJson(view.state.doc).content[0].content[0].marks, [
    { attrs: { href: "https://example.com" }, type: "link" },
  ]);
  assert.equal(view.state.selection.empty, true);
  assert.equal(view.state.selection.from, 10);
  assert.deepEqual(view.state.storedMarks, []);
});

test("paste handler canonicalizes Buzz links over selected text", () => {
  const doc = document(paragraph(text("selected")));
  const view = createMockView(stateFromDocument(doc, 1, 9));
  const event = createPasteEvent(HREF);
  const handled = createComposerLinkPasteHandler(resolveKnownChannel)(
    view,
    event,
  );

  assert.equal(handled, true);
  assert.equal(view.state.doc.textContent, "selected");
  assert.deepEqual(toPlainJson(view.state.doc).content[0].content[0].marks, [
    {
      attrs: { href: HREF },
      type: "link",
    },
  ]);
});

test("paste handler consumes idempotent wrapped link over selected text", () => {
  const href = "https://example.com";
  const linkMark = editorSchema.marks.link.create({ href });
  const doc = document(paragraph(text("already linked", [linkMark])));
  const view = createMockView(stateFromDocument(doc, 1, 15));
  const event = createPasteEvent(`<${href}>`);
  const handled = createComposerLinkPasteHandler(resolveKnownChannel)(
    view,
    event,
  );

  assert.equal(handled, true);
  assert.equal(event.defaultPrevented, true);
  assert.equal(view.focusCalled, true);
  assert.equal(view.state.doc.textContent, "already linked");
  assert.deepEqual(toPlainJson(view.state.doc).content[0].content[0].marks, [
    { attrs: { href }, type: "link" },
  ]);
  assert.equal(view.state.selection.empty, true);
  assert.equal(view.state.selection.from, 15);
  assert.deepEqual(view.state.storedMarks, []);
});

test("paste handler falls through when selected text cannot carry link marks", () => {
  const doc = document(codeBlock(text("const value = 1;")));
  const view = createMockView(stateFromDocument(doc, 1, 17));
  const event = createPasteEvent("https://example.com");
  const handled = createComposerLinkPasteHandler(resolveKnownChannel)(
    view,
    event,
  );

  assert.equal(handled, false);
  assert.equal(event.defaultPrevented, false);
  assert.equal(view.focusCalled, false);
  assert.equal(view.state.doc.textContent, "const value = 1;");
  assert.deepEqual(toPlainJson(view.state.doc).content[0].content[0], {
    text: "const value = 1;",
    type: "text",
  });
});

test("paste handler falls through when any selected text cannot carry link marks", () => {
  const doc = document(
    paragraph(text("ordinary")),
    codeBlock(text("const value = 1;")),
  );
  const view = createMockView(stateFromDocument(doc, 1, doc.content.size - 1));
  const initialDoc = toPlainJson(view.state.doc);
  const initialSelection = view.state.selection.toJSON();
  const event = createPasteEvent("https://example.com");
  const handled = createComposerLinkPasteHandler(resolveKnownChannel)(
    view,
    event,
  );

  assert.equal(handled, false);
  assert.equal(event.defaultPrevented, false);
  assert.equal(view.focusCalled, false);
  assert.deepEqual(toPlainJson(view.state.doc), initialDoc);
  assert.deepEqual(view.state.selection.toJSON(), initialSelection);
});

test("paste handler falls through when selected text mixes plain and inline code", () => {
  const doc = document(
    paragraph(
      text("plain "),
      text("inline", [editorSchema.marks.code.create()]),
    ),
  );
  const view = createMockView(stateFromDocument(doc, 1, doc.content.size - 1));
  const initialDoc = toPlainJson(view.state.doc);
  const initialSelection = view.state.selection.toJSON();
  const event = createPasteEvent("https://example.com");
  const handled = createComposerLinkPasteHandler(resolveKnownChannel)(
    view,
    event,
  );

  assert.equal(handled, false);
  assert.equal(event.defaultPrevented, false);
  assert.equal(view.focusCalled, false);
  assert.deepEqual(toPlainJson(view.state.doc), initialDoc);
  assert.deepEqual(view.state.selection.toJSON(), initialSelection);
});

test("paste handler links selected text for linkify-only URL shapes", () => {
  for (const [pasted, expectedHref] of [
    ["www.example.com", "http://www.example.com"],
    ["foo@example.com", "mailto:foo@example.com"],
  ]) {
    const doc = document(paragraph(text("read this")));
    const view = createMockView(stateFromDocument(doc, 1, 10));
    const handled = createComposerLinkPasteHandler(resolveKnownChannel)(
      view,
      createPasteEvent(pasted),
    );

    assert.equal(handled, true);
    assert.equal(view.state.doc.textContent, "read this");
    assert.deepEqual(toPlainJson(view.state.doc).content[0].content[0].marks, [
      { attrs: { href: expectedHref }, type: "link" },
    ]);
  }
});

test("caret paste stays plain for linkify-only URL shapes", () => {
  // Only the selection branch widened. A caret paste of `www.example.com` must
  // still fall through so it arrives as text for `autolink` to pick up, rather
  // than being inserted as a pre-linked node.
  const doc = document(paragraph(text("go ")));
  const view = createMockView(stateFromDocument(doc, 4));
  const event = createPasteEvent("www.example.com");
  const handled = createComposerLinkPasteHandler(resolveKnownChannel)(
    view,
    event,
  );

  assert.equal(handled, false);
  assert.equal(event.defaultPrevented, false);
  assert.equal(view.state.doc.textContent, "go ");
});

test("paste handler collapses an all-selection to inline content", () => {
  const doc = document(paragraph(text("select all")));
  const view = createMockView(allSelectionStateFromDocument(doc));
  const event = createPasteEvent("https://example.com");
  const handled = createComposerLinkPasteHandler(resolveKnownChannel)(
    view,
    event,
  );

  assert.equal(handled, true);
  assert.equal(view.state.doc.textContent, "select all");
  assert.deepEqual(toPlainJson(view.state.doc).content[0].content[0].marks, [
    { attrs: { href: "https://example.com" }, type: "link" },
  ]);
  assert.equal(view.state.selection.empty, true);
  assert.equal(view.state.selection.from, 11);
  assert.equal(view.state.selection.$from.parent.type.name, "paragraph");
});

test("paste handler replaces selected text when it contains a composer chip", () => {
  const doc = document(
    paragraph(text("before "), composerChip(), text(" after")),
  );
  const view = createMockView(stateFromDocument(doc, 1, doc.content.size - 1));
  const event = createPasteEvent("https://example.com");
  const handled = createComposerLinkPasteHandler(resolveKnownChannel)(
    view,
    event,
  );

  assert.equal(handled, true);
  assert.equal(view.state.doc.textContent, "https://example.com ");
  assert.deepEqual(toPlainJson(view.state.doc).content[0].content, [
    {
      marks: [{ attrs: { href: "https://example.com" }, type: "link" }],
      text: "https://example.com",
      type: "text",
    },
    { text: " ", type: "text" },
  ]);
});

test("paste handler preserves caret paste behavior", () => {
  const doc = document(paragraph(text("go ")));
  const view = createMockView(stateFromDocument(doc, 4));
  const event = createPasteEvent(HREF);
  const handled = createComposerLinkPasteHandler(resolveKnownChannel)(
    view,
    event,
  );

  assert.equal(handled, true);
  assert.equal(view.state.doc.textContent, "go  ");
  assert.deepEqual(toPlainJson(view.state.doc).content[0].content, [
    { text: "go ", type: "text" },
    {
      attrs: { channelName: "general", href: HREF },
      type: "composerMessageLink",
    },
    { text: " ", type: "text" },
  ]);
});

function captureMarkdownRule() {
  let capturedAnchor = null;
  let capturedRule = null;
  const md = {
    renderer: { rules: {} },
    inline: {
      ruler: {
        before(anchor, _name, rule) {
          capturedAnchor = anchor;
          capturedRule = rule;
        },
      },
    },
    utils: {
      escapeHtml: (value) => value.replaceAll("&", "&amp;"),
    },
  };
  registerComposerMessageLinkMarkdownIt(md, {
    resolveChannelName: (channelId) =>
      channelId === CHANNEL_ID ? "general" : undefined,
  });
  return { anchor: capturedAnchor, md, rule: capturedRule };
}

test("markdown parsing materializes a bare message link in composer content", () => {
  const { anchor, rule } = captureMarkdownRule();
  assert.equal(anchor, "text");
  let token = null;
  const state = {
    src: `See ${HREF}.`,
    pos: 4,
    push: () => {
      token = { meta: null };
      return token;
    },
  };

  assert.equal(rule(state, false), true);
  assert.equal(state.pos, 4 + HREF.length);
  assert.deepEqual(token.meta, { channelName: "general", href: HREF });
});

test("real markdown-it parsing materializes a restored message link", () => {
  const md = new MarkdownIt();
  registerComposerMessageLinkMarkdownIt(md, {
    resolveChannelName: (channelId) =>
      channelId === CHANNEL_ID ? "general" : undefined,
  });

  const html = md.renderInline(`See ${HREF}.`);
  assert.match(html, /See <span data-composer-message-link=""/);
  assert.match(html, /data-channel-name="general"/);
  assert.match(html, /data-href="buzz:\/\/message\?channel=.*&amp;id=/);
});

test("markdown parsing resumes after markdown-it consumes the buzz prefix", () => {
  const { rule } = captureMarkdownRule();
  let token = null;
  const state = {
    pending: "See buzz",
    src: `See ${HREF}`,
    pos: "See buzz".length,
    push: () => {
      token = { meta: null };
      return token;
    },
  };

  assert.equal(rule(state, false), true);
  assert.equal(state.pending, "See ");
  assert.equal(state.pos, state.src.length);
  assert.deepEqual(token.meta, { channelName: "general", href: HREF });
});

test("markdown parsing stops message links before emphasis delimiters", () => {
  const { rule } = captureMarkdownRule();
  let token = null;
  const state = {
    src: `${HREF}*`,
    pos: 0,
    push: () => {
      token = { meta: null };
      return token;
    },
  };

  assert.equal(rule(state, false), true);
  assert.equal(state.pos, HREF.length);
  assert.deepEqual(token.meta, { channelName: "general", href: HREF });
});

test("markdown rendering stores identity in attributes, not visible id text", () => {
  const { md } = captureMarkdownRule();
  const render = md.renderer.rules.buzz_composer_message_link;
  const html = render([{ meta: { channelName: "general", href: HREF } }], 0);

  assert.match(html, /data-composer-message-link=""/);
  assert.match(html, /data-channel-name="general"/);
  assert.match(html, /data-href="buzz:\/\/message\?channel=.*&amp;id=/);
  assert.doesNotMatch(html, />[^<]*root-event/);
});
