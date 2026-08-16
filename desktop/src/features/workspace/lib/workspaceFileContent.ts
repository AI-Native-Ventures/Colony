import { invoke } from "@/shared/api/nativeBridge";
import { fetchMediaBytes } from "@/shared/api/tauriMedia";

import type { FileSource } from "./filePayload";

/** The shape `read_workspace_file` returns for a local file. */
type NativeWorkspaceFile = {
  path: string;
  name: string;
  mime: string;
  bytes_base64: string;
  size: number;
  is_text: boolean;
};

/** A loaded file, however it was fetched. */
export type LoadedWorkspaceFile = {
  name: string;
  mime: string;
  isText: boolean;
  bytesBase64: string;
};

type LoadDependencies = {
  fetchBytes: (url: string) => Promise<Uint8Array>;
  readLocalFile: (path: string) => Promise<NativeWorkspaceFile>;
};

const DEFAULT_DEPENDENCIES: LoadDependencies = {
  fetchBytes: fetchMediaBytes,
  readLocalFile: (path) =>
    invoke<NativeWorkspaceFile>("read_workspace_file", { path }),
};

/** Whether a MIME type renders in the `file` kind's text view. */
export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json";
}

/** Base64 for bytes, chunked so a large file cannot blow the argument limit. */
export function encodeBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return globalThis.btoa(binary);
}

/**
 * Load a workspace tab's file from wherever it lives.
 *
 * A message attachment has no local copy, so its bytes come over the same
 * validated relay-media path the download action uses rather than off disk.
 * Both cases end up as base64 so the viewers stay one code path.
 */
export async function loadWorkspaceFile(
  source: FileSource,
  dependencies: LoadDependencies = DEFAULT_DEPENDENCIES,
): Promise<LoadedWorkspaceFile> {
  if (source.kind === "path") {
    const file = await dependencies.readLocalFile(source.path);
    return {
      name: file.name,
      mime: file.mime,
      isText: file.is_text,
      bytesBase64: file.bytes_base64,
    };
  }

  const bytes = await dependencies.fetchBytes(source.url);
  return {
    name: source.name,
    mime: source.mime,
    isText: isTextMime(source.mime),
    bytesBase64: encodeBase64(bytes),
  };
}
