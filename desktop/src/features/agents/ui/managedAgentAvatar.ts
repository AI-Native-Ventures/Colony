type BlobDescriptor = {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
};

export type UploadMediaBytes = (
  data: number[],
  filename?: string,
) => Promise<BlobDescriptor>;

export async function resolveManagedAgentAvatarUrl(
  avatarUrl: string | null | undefined,
  upload: UploadMediaBytes = defaultUploadMediaBytes,
  fallbackAvatarUrl?: string | null,
): Promise<string | undefined> {
  const resolvedAvatarUrl = avatarUrl?.trim() || undefined;
  if (!resolvedAvatarUrl?.startsWith("data:image/")) {
    return resolvedAvatarUrl;
  }

  // Emoji avatars are stored as inline, percent-encoded SVG data URLs
  // (`data:image/svg+xml,%3C...`) — the same self-contained form profile
  // persists. They are not base64 and must not be run through `atob`/upload;
  // pass them through unchanged so the emoji survives agent creation.
  if (!isBase64DataUri(resolvedAvatarUrl)) {
    return resolvedAvatarUrl;
  }

  try {
    const [, b64] = resolvedAvatarUrl.split(",", 2);
    if (!b64) {
      throw new Error("empty data URI payload");
    }
    const bytes = Array.from(atob(b64), (char) => char.charCodeAt(0));
    const blob = await upload(bytes);
    return blob.url;
  } catch {
    return safeFallbackAvatarUrl(fallbackAvatarUrl);
  }
}

export type RasterizeSvgDataUrlToPngBytes = (
  svgDataUrl: string,
) => Promise<number[]>;

/**
 * Resolve an avatar for wire formats that only accept remote URLs — block
 * safe actions reject every `data:` URL as an anti-embedding boundary, so
 * the inline emoji SVGs that {@link resolveManagedAgentAvatarUrl} passes
 * through would fail schema validation there. Emoji avatars are rasterized
 * to PNG and uploaded instead; the result is always `https://` or a safe
 * non-data fallback, never an inline payload.
 */
export async function resolveRemoteManagedAgentAvatarUrl(
  avatarUrl: string | null | undefined,
  upload: UploadMediaBytes = defaultUploadMediaBytes,
  fallbackAvatarUrl?: string | null,
  rasterize: RasterizeSvgDataUrlToPngBytes = defaultRasterizeSvgDataUrlToPngBytes,
): Promise<string | undefined> {
  const resolved = await resolveManagedAgentAvatarUrl(
    avatarUrl,
    upload,
    fallbackAvatarUrl,
  );
  if (!resolved?.startsWith("data:image/")) {
    // Non-remote schemes (e.g. the app-avatar:// harness icons) fail the
    // same https-only schema; omitting the avatar lets the backend apply
    // its own default instead of failing the whole action.
    return httpUrlOrUndefined(resolved);
  }

  try {
    const bytes = await rasterize(resolved);
    const blob = await upload(bytes, "avatar.png");
    return blob.url;
  } catch {
    return httpUrlOrUndefined(safeFallbackAvatarUrl(fallbackAvatarUrl));
  }
}

function httpUrlOrUndefined(url: string | undefined) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

// Emoji avatar SVGs carry explicit width/height (512x512, see
// ProfileAvatarEditor.utils.ts), which WebKit requires to paint an SVG
// image onto a canvas.
async function defaultRasterizeSvgDataUrlToPngBytes(
  svgDataUrl: string,
): Promise<number[]> {
  const image = new Image();
  image.src = svgDataUrl;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("canvas 2d context unavailable");
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!blob) {
    throw new Error("png encode failed");
  }
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

async function defaultUploadMediaBytes(data: number[], filename?: string) {
  const { uploadMediaBytes } = await import("@/shared/api/tauri");
  return uploadMediaBytes(data, filename);
}

function isBase64DataUri(dataUri: string) {
  const header = dataUri.slice(0, dataUri.indexOf(","));
  return header.includes(";base64");
}

function safeFallbackAvatarUrl(avatarUrl: string | null | undefined) {
  const trimmed = avatarUrl?.trim() || undefined;
  return trimmed?.startsWith("data:image/") ? undefined : trimmed;
}
