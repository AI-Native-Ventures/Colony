import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { setNativeBridge } from "@/shared/api/nativeBridge";
import { createMockNativeBridge } from "@/testing/createMockNativeBridge";
import { MAX_FILE_PREVIEW_BYTES } from "./filePreviewModel.ts";

const mediaReads = [];
let mediaRead = async () => new Uint8Array([1, 2, 3]);
mock.module("@/shared/api/tauriMedia", {
  namedExports: {
    fetchMediaBytes: async (url) => {
      mediaReads.push(url);
      return mediaRead();
    },
  },
});
const { loadFilePreview, readBundledPreview, downloadFilePreviewOriginal } =
  await import("./filePreviewLoad.ts");

const signal = () => new AbortController().signal;

test("bundled bytes use no credentials or redirects, and declared and streamed size failures cancel the reader", async (t) => {
  let cancelled = 0;
  let header = null;
  let chunks = [new Uint8Array([65, 44, 66])];
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (chunks.length) controller.enqueue(chunks.shift());
          // Remain open after the oversized first chunk: cancellation is observable.
          else if (!header) controller.close();
        },
        cancel() {
          cancelled++;
        },
      }),
      { headers: header ? { "content-length": header } : {} },
    );
  });
  assert.deepEqual(
    await readBundledPreview("/rich-previews/source.csv", signal()),
    new Uint8Array([65, 44, 66]),
  );
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.redirect, "error");
  header = String(MAX_FILE_PREVIEW_BYTES + 1);
  chunks = [];
  await assert.rejects(
    readBundledPreview("/rich-previews/source.csv", signal()),
    /8 MB/,
  );
  assert.equal(cancelled, 1);
  header = "1"; // A dishonest header cannot bypass actual byte counting.
  chunks = [new Uint8Array(MAX_FILE_PREVIEW_BYTES + 1)];
  await assert.rejects(
    readBundledPreview("/rich-previews/source.csv", signal()),
    /8 MB/,
  );
  assert.equal(cancelled, 2);
});

test("unsafe sources never call native media or fetch, and local reads must resolve containment first", async (t) => {
  mediaReads.length = 0;
  const fetch = t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected browser fetch");
  });
  for (const href of [
    "javascript:alert(1)",
    "file:///secret.csv",
    "https://user:pass@example.test/a.csv",
  ]) {
    await assert.rejects(
      loadFilePreview({ href }, signal()),
      /cannot be previewed/,
    );
    await assert.rejects(
      downloadFilePreviewOriginal({ href }, "source.csv", "text/csv"),
      /cannot be downloaded/,
    );
  }
  await assert.rejects(
    readBundledPreview("https://example.test/source.csv", signal()),
    /not a bundled/,
  );
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(mediaReads.length, 0);
  const calls = [];
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      if (command === "resolve_workspace_path")
        throw new Error("Outside workspace");
      throw new Error("Must not read a rejected path");
    }),
  );
  await assert.rejects(
    loadFilePreview({ localPath: "/secret.csv" }, signal()),
    /Outside workspace/,
  );
  assert.deepEqual(
    calls.map((item) => item.command),
    ["resolve_workspace_path"],
  );
});

test("workspace bytes use the resolved path and remote reads discard late results after cancellation", async () => {
  const calls = [];
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      if (command === "resolve_workspace_path")
        return { path: "/workspace/report.csv" };
      return { bytes_base64: btoa("source,values"), size: 13 };
    }),
  );
  const bytes = await loadFilePreview({ localPath: "report.csv" }, signal());
  assert.equal(new TextDecoder().decode(bytes), "source,values");
  assert.deepEqual(calls[1], {
    command: "read_workspace_file",
    args: { path: "/workspace/report.csv" },
  });
  const controller = new AbortController();
  let finish;
  mediaRead = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = loadFilePreview(
    { href: "https://relay.test/media/source.csv" },
    controller.signal,
  );
  controller.abort();
  finish(new Uint8Array([1]));
  await assert.rejects(pending, /cancelled/);
});

test("remote original download invokes the native source URL even without preview bytes", async () => {
  const calls = [];
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
    }),
  );
  await downloadFilePreviewOriginal(
    { href: "https://relay.test/media/source.xlsx" },
    "source.xlsx",
    "",
    new Uint8Array([99]),
  );
  assert.deepEqual(calls, [
    {
      command: "download_file",
      args: {
        url: "https://relay.test/media/source.xlsx",
        filename: "source.xlsx",
      },
    },
  ]);
});

test("local preview rejects oversized declared and encoded values before base64 decoding", async (t) => {
  let file = { size: MAX_FILE_PREVIEW_BYTES + 1, bytes_base64: "" };
  setNativeBridge(
    createMockNativeBridge(async (command) =>
      command === "resolve_workspace_path"
        ? { path: "/workspace/large.csv" }
        : file,
    ),
  );
  const decode = t.mock.method(globalThis, "atob", () => {
    throw new Error("Should not decode oversized input");
  });
  await assert.rejects(
    loadFilePreview({ localPath: "large.csv" }, signal()),
    /8 MB/,
  );
  file = {
    size: 1,
    bytes_base64: "A".repeat(Math.ceil((MAX_FILE_PREVIEW_BYTES + 1) / 3) * 4),
  };
  await assert.rejects(
    loadFilePreview({ localPath: "large.csv" }, signal()),
    /8 MB/,
  );
  assert.equal(decode.mock.callCount(), 0);
});

test("already loaded native-picker bytes preview without reinterpreting the chosen path as a message", async () => {
  setNativeBridge(
    createMockNativeBridge(() => {
      throw new Error("Already loaded file must not be read again");
    }),
  );
  const bytes = await loadFilePreview(
    { workspaceBytesBase64: btoa("chosen,value\nA,01") },
    signal(),
  );
  assert.equal(new TextDecoder().decode(bytes), "chosen,value\nA,01");
  await assert.rejects(
    loadFilePreview(
      {
        workspaceBytesBase64: "A".repeat(
          Math.ceil((MAX_FILE_PREVIEW_BYTES + 1) / 3) * 4,
        ),
      },
      signal(),
    ),
    /8 MB/,
  );
});
