/**
 * The kit face, inlined.
 *
 * Inside a `foreignObject` a font referenced by family name or by URL falls
 * back **silently** — the raster comes out in a system face while every DOM
 * measurement still reports the intended one. The spike that proved the
 * capture path measured a 20.1 luminance delta between the two, which is why
 * the font gate exists at all; this module is the other half of that answer.
 * The face must arrive as a base64 `data:` URI, and it must be registered in
 * the document before the SVG image is drawn (`capture.ts` does the second
 * part).
 *
 * The family is deliberately **not** "Inter". The app already loads Inter
 * ambiently, so a card that named it would resolve against the document's copy
 * whether or not the inline face landed, and the zero-fallback gate would pass
 * on a card whose bytes never carried the kit face. "Inter Kit" exists nowhere
 * else, so the gate's control frame genuinely has nothing to fall back to.
 */

/** The family name the card stylesheet sets its type in. */
export const KIT_FAMILY = "Inter Kit";

/**
 * The `@font-face` rule for a base64 woff2 payload.
 *
 * Pure, so the shape of the rule is testable without a browser or a font file.
 * A variable face declares its whole weight range: the cards set headlines at
 * 600 and the lockup line at 600, and a face pinned to 400 would synthesise
 * the difference rather than render it.
 */
export function kitFontFaceCss(
  base64: string,
  {
    family = KIT_FAMILY,
    weights = "100 900",
  }: { family?: string; weights?: string } = {},
): string {
  if (base64.length === 0) {
    throw new Error(
      "font kit: refusing to build a face around an empty payload",
    );
  }
  if (/[^A-Za-z0-9+/=]/.test(base64)) {
    throw new Error("font kit: the payload is not base64");
  }
  return (
    `@font-face{font-family:"${family}";font-style:normal;` +
    `font-weight:${weights};font-display:block;` +
    `src:url(data:font/woff2;base64,${base64}) format("woff2")}`
  );
}

/** Base64 for a byte buffer, without a data-URI prefix. */
export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: `String.fromCharCode(...bytes)` on a 48KB face overflows the
  // argument list in WebKit before it overflows anything else.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Fetch the bundled variable Inter and return its `@font-face` rule.
 *
 * The URL comes from the bundler rather than from a hardcoded path, so the
 * hashed asset name stays the bundler's business. Cached for the session: the
 * face is ~48KB and every slide of every card wants the same one.
 */
let cached: Promise<string> | null = null;

export function loadKitFontFace(): Promise<string> {
  if (!cached) {
    cached = (async () => {
      const url = (
        await import(
          "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url"
        )
      ).default;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `font kit: the kit face did not load (${response.status})`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0) {
        throw new Error("font kit: the kit face loaded as zero bytes");
      }
      return kitFontFaceCss(base64Of(bytes));
    })().catch((error) => {
      // A failed load must not be cached, or one offline moment poisons the
      // renderer for the rest of the session.
      cached = null;
      throw error;
    });
  }
  return cached;
}

/** Drop the cached face. Called when a community switch resets render state. */
export function resetKitFontFace(): void {
  cached = null;
}
