import assert from "node:assert/strict";
import test from "node:test";

import { readFileSource } from "./filePayload.ts";
import {
  encodeBase64,
  loadWorkspaceFile,
  resolveWorkspaceFilePresentation,
} from "./workspaceFileContent.ts";

function bytesOf(text) {
  return new TextEncoder().encode(text);
}

test("a payload names either a local path or an attachment URL", () => {
  assert.deepEqual(readFileSource({ path: "/w/a.md" }), {
    kind: "path",
    path: "/w/a.md",
  });
  assert.deepEqual(
    readFileSource({
      url: "https://relay.example/media/a.pdf",
      name: "Q3.pdf",
      mime: "application/pdf",
    }),
    {
      kind: "url",
      url: "https://relay.example/media/a.pdf",
      name: "Q3.pdf",
      mime: "application/pdf",
    },
  );
  assert.equal(readFileSource({ path: null }), null);
  assert.equal(readFileSource(null), null);
});

test("a URL payload falls back to the URL tail and an unknown MIME", () => {
  assert.deepEqual(
    readFileSource({ url: "https://relay.example/media/a.pdf" }),
    {
      kind: "url",
      url: "https://relay.example/media/a.pdf",
      name: "a.pdf",
      mime: "application/octet-stream",
    },
  );
});

test("a local file is read over IPC and classifies its presentation", async () => {
  const file = await loadWorkspaceFile(
    { kind: "path", path: "/w/a.md" },
    {
      fetchBytes: async () => {
        throw new Error("must not fetch for a local path");
      },
      readLocalFile: async (path) => {
        assert.equal(path, "/w/a.md");
        return {
          path,
          name: "a.md",
          mime: "text/markdown",
          bytes_base64: encodeBase64(bytesOf("# hello")),
          size: 7,
          is_text: true,
        };
      },
    },
  );

  assert.deepEqual(file, {
    name: "a.md",
    mime: "text/markdown",
    presentation: "text",
    bytesBase64: encodeBase64(bytesOf("# hello")),
  });
});

test("an attachment is fetched over the media path, never off disk", async () => {
  const file = await loadWorkspaceFile(
    {
      kind: "url",
      url: "https://relay.example/media/a.md",
      name: "a.md",
      mime: "text/markdown",
    },
    {
      fetchBytes: async (url) => {
        assert.equal(url, "https://relay.example/media/a.md");
        return bytesOf("# remote");
      },
      readLocalFile: async () => {
        throw new Error("must not read the disk for an attachment");
      },
    },
  );

  assert.deepEqual(file, {
    name: "a.md",
    mime: "text/markdown",
    presentation: "text",
    bytesBase64: encodeBase64(bytesOf("# remote")),
  });
});

test("classifies trusted text, extension-backed text, PDF, and binary files", () => {
  assert.equal(
    resolveWorkspaceFilePresentation("notes.md", "application/octet-stream"),
    "text",
  );
  assert.equal(
    resolveWorkspaceFilePresentation("data.json", "application/json"),
    "text",
  );
  assert.equal(
    resolveWorkspaceFilePresentation("paper.pdf", "application/pdf"),
    "pdf",
  );
  assert.equal(
    resolveWorkspaceFilePresentation("paper.PDF", "application/octet-stream"),
    "pdf",
  );
  assert.equal(
    resolveWorkspaceFilePresentation("payload.exe", "application/octet-stream"),
    "binary",
  );
  assert.equal(
    resolveWorkspaceFilePresentation("page.html", "text/html"),
    "binary",
  );
});

test("base64 encoding survives a payload larger than one chunk", () => {
  const big = new Uint8Array(0x8000 * 2 + 5).fill(65);
  assert.equal(encodeBase64(big), globalThis.btoa("A".repeat(big.length)));
});
