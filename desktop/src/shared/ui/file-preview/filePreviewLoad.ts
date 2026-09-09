import { invoke } from "@/shared/api/nativeBridge";
import { fetchMediaBytes } from "@/shared/api/tauriMedia";
import {
  assertFilePreviewSize,
  classifyFilePreviewUrl,
  MAX_FILE_PREVIEW_BYTES,
} from "./filePreviewModel";

/** Attachment sources are explicit: untrusted URLs never become filesystem paths. */
export type FilePreviewSource = {
  href?: string;
  localPath?: string;
  /** Bytes already read through the workspace's native file-picker path. */
  workspaceBytesBase64?: string;
};
type LocalFile = { bytes_base64: string; size: number };

function decodeWorkspaceBytes(
  encoded: string,
  preview: boolean,
): Uint8Array<ArrayBuffer> {
  if (preview) {
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    assertFilePreviewSize(Math.floor(encoded.length / 4) * 3 - padding);
  }
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function readLocal(
  path: string,
  preview = true,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const resolved = await invoke<{ path: string }>("resolve_workspace_path", {
    path,
  });
  if (signal?.aborted) throw new Error("Preview cancelled");
  const file = await invoke<LocalFile>("read_workspace_file", {
    path: resolved.path,
  });
  if (signal?.aborted) throw new Error("Preview cancelled");
  if (preview) {
    assertFilePreviewSize(file.size);
  }
  return decodeWorkspaceBytes(file.bytes_base64, preview);
}

/** Read a same-origin shipped example progressively, without cookies or redirects. */
export async function readBundledPreview(
  href: string,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (classifyFilePreviewUrl(href) !== "bundled")
    throw new Error("This is not a bundled file preview.");
  const response = await fetch(href, {
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if (!response.ok || !response.body) throw new Error("File unavailable");
  const reader = response.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    const declared = response.headers.get("content-length");
    if (declared !== null) assertFilePreviewSize(Number(declared));
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      assertFilePreviewSize(total);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Use the existing native media validation/tunnel; never fetch arbitrary browser credentials. */
export async function loadFilePreview(
  source: FilePreviewSource,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (signal.aborted) throw new Error("Preview cancelled");
  let bytes: Uint8Array<ArrayBuffer>;
  if (source.workspaceBytesBase64 !== undefined)
    bytes = decodeWorkspaceBytes(source.workspaceBytesBase64, true);
  else if (source.localPath && !source.href)
    bytes = await readLocal(source.localPath, true, signal);
  else {
    const policy = classifyFilePreviewUrl(source.href || "");
    if (!policy) throw new Error("This file source cannot be previewed.");
    bytes =
      policy === "bundled"
        ? await readBundledPreview(source.href || "", signal)
        : await fetchMediaBytes(source.href || "");
  }
  if (signal.aborted) throw new Error("Preview cancelled");
  assertFilePreviewSize(bytes.byteLength);
  return bytes;
}

function downloadBytes(
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  mime: string,
): void {
  const url = URL.createObjectURL(
    new Blob([bytes], { type: mime || "application/octet-stream" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = Array.from(filename, (character) =>
    character.charCodeAt(0) < 32 || character === "/" || character === "\\"
      ? "_"
      : character,
  ).join("");
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Download original bytes, never table exports or PDF canvas renditions. */
export async function downloadFilePreviewOriginal(
  source: FilePreviewSource,
  filename: string,
  mime: string,
  loaded?: Uint8Array<ArrayBuffer>,
): Promise<void> {
  if (source.workspaceBytesBase64 !== undefined) {
    downloadBytes(
      loaded || decodeWorkspaceBytes(source.workspaceBytesBase64, false),
      filename,
      mime,
    );
    return;
  }
  if (source.localPath && !source.href) {
    downloadBytes(
      loaded || (await readLocal(source.localPath, false)),
      filename,
      mime,
    );
    return;
  }
  const policy = classifyFilePreviewUrl(source.href || "");
  if (!policy) throw new Error("This file source cannot be downloaded.");
  if (policy === "media") {
    await invoke("download_file", { url: source.href, filename });
    return;
  }
  const bytes =
    loaded ||
    (await readBundledPreview(source.href || "", new AbortController().signal));
  if (bytes.length > MAX_FILE_PREVIEW_BYTES)
    throw new Error("File exceeds download limit");
  downloadBytes(bytes, filename, mime);
}
