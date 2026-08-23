/**
 * The capture path: card markup to PNG bytes, entirely offscreen, inside the
 * desktop webview (WKWebView on macOS, WebKit2GTK on Linux).
 *
 * The technique is the one proven in
 * `desktop/tests/spikes/webkit-rasterisation-spike.mjs`, not a new invention:
 *
 * 1. The stylesheet's `@font-face` rules are registered through the FontFace
 *    API and awaited. Inside a foreignObject a font referenced by name or URL
 *    silently falls back, so the kit ships the face inlined as a base64 data:
 *    URI in the CSS (exactly as colony-social-kit's tools/build-posts.mjs
 *    line 281 does) and the face must be warm in the document before the SVG
 *    image is drawn.
 * 2. The card markup is serialised into an SVG foreignObject carrying the
 *    whole stylesheet in a CDATA block.
 * 3. The SVG reaches the <img> through a data: URI. Never a blob: URL: blob:
 *    taints the canvas in both engines, getImageData then throws "The
 *    operation is insecure.", and no pixel gate can ever read a pixel. The
 *    spike's first run failed in both engines for exactly this reason.
 * 4. The image is drawn onto a canvas that is never attached to the document,
 *    so the capture has no visible surface and no window of its own.
 *
 * Nothing here judges the pixels. Gates live elsewhere; this module renders,
 * reports the sampled luminance variance as a diagnostic, and hands back
 * deterministic bytes with their hash.
 */

/** The result of one capture: bytes, their hash, and the diagnostic a test
 * or gate needs to prove the canvas was not blank. */
export type CaptureResult = {
  /** Encoded PNG bytes. */
  png: Uint8Array;
  /** SHA-256 of {@link CaptureResult.png}, bare lowercase hex. */
  sha256: string;
  width: number;
  height: number;
  /**
   * Variance of sampled pixel luminance on the 0-255 scale. A blank canvas
   * still encodes a perfectly valid PNG, so byte length proves nothing;
   * variance near zero is the blank signature. The spike measured 1151 on a
   * painted card against 0 on a blank one.
   */
  pixelVariance: number;
};

// ---------------------------------------------------------------------------
// sha256, hand-rolled so the hash needs no crypto.subtle (which exists only
// in secure contexts) and no imports, keeping this module loadable both as a
// plain module and as injected browser source. Verified against node:crypto
// in capture.test.mjs.
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number =>
  ((x >>> n) | (x << (32 - n))) >>> 0;

/** SHA-256 of `bytes` as bare lowercase hex. Synchronous, no dependencies. */
export function sha256Hex(bytes: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = bytes.length;
  // 0x80 padding, zeros, then the 64-bit big-endian bit length; total a
  // multiple of 64 bytes.
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  view.setUint32(padded.length - 4, (len << 3) >>> 0);

  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(off + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  let hex = "";
  for (const word of h) {
    hex += word.toString(16).padStart(8, "0");
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Font warming
// ---------------------------------------------------------------------------

type FontFaceSpec = {
  display?: string;
  family: string;
  src: string;
  weight?: string;
};

const FONT_DISPLAYS = [
  "auto",
  "block",
  "swap",
  "fallback",
  "optional",
] as const;

/**
 * The bodies of every `@font-face` rule, read by balancing braces rather than
 * with a `[^}]*` class: a base64 payload happens never to contain a closing
 * brace, but the parser has no business assuming that.
 */
function fontFaceBodies(css: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf("@font-face", from);
    if (at < 0) {
      break;
    }
    const open = css.indexOf("{", at);
    if (open < 0) {
      break;
    }
    let depth = 1;
    let quote: string | null = null;
    let i = open + 1;
    for (; i < css.length && depth > 0; i++) {
      const ch = css[i];
      if (quote) {
        if (ch === "\\") {
          i++;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (depth === 0) {
      bodies.push(css.slice(open + 1, i - 1));
    }
    from = i;
  }
  return bodies;
}

/**
 * One descriptor's value, read to the end of its declaration: a semicolon
 * inside url(...) or a quoted string does not end it. A base64 data URI
 * always contains one (";base64,"), so a `[^;}]+` character class truncates
 * mid-URI and the FontFace API then throws NetworkError on the malformed
 * source.
 */
function readDescriptor(body: string, name: string): string | null {
  const head = body.match(new RegExp(`${name}\\s*:\\s*`));
  if (!head || head.index === undefined) {
    return null;
  }
  const start = head.index + head[0].length;
  let depth = 0;
  let quote: string | null = null;
  let i = start;
  for (; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (ch === ";" && depth === 0) {
      break;
    }
  }
  return body.slice(start, i).trim() || null;
}

/** Pull the `@font-face` rules out of a stylesheet as FontFace specs. */
export function extractFontFaces(css: string): FontFaceSpec[] {
  const specs: FontFaceSpec[] = [];
  for (const body of fontFaceBodies(css)) {
    const family = readDescriptor(body, "font-family");
    const src = readDescriptor(body, "src");
    if (!family || !src) {
      continue;
    }
    specs.push({
      display: FONT_DISPLAYS.find(
        (valid) => valid === readDescriptor(body, "font-display"),
      ),
      family: family.replace(/^["']|["']$/g, ""),
      src,
      weight: readDescriptor(body, "font-weight"),
    });
  }
  return specs;
}

/**
 * Register every `@font-face` in `css` through the FontFace API and wait for
 * the document's fonts to settle. This warms the inlined data: URI faces in
 * the ambient document without touching its DOM, which is what the proven
 * sequence requires before the SVG image is drawn. Returns the added faces so
 * the caller can remove them again.
 */
async function warmFonts(css: string): Promise<FontFace[]> {
  const added: FontFace[] = [];
  for (const spec of extractFontFaces(css)) {
    const face = new FontFace(spec.family, spec.src, {
      display: spec.display,
      weight: spec.weight,
    });
    try {
      await face.load();
    } catch (e) {
      throw new Error(
        `capture: kit font "${spec.family}" failed to load (${e}); inside ` +
          `foreignObject a font referenced by name or URL silently falls ` +
          `back, so it must inline as a base64 data: URI`,
      );
    }
    document.fonts.add(face);
    added.push(face);
  }
  await document.fonts.ready;
  return added;
}

// ---------------------------------------------------------------------------
// SVG serialisation and rasterisation
// ---------------------------------------------------------------------------

/**
 * The card as an SVG document: the whole stylesheet in a CDATA block, the
 * card markup inside a sized XHTML-namespaced wrapper. `cardHtml` must be
 * XHTML-well-formed (balanced tags, quoted attributes, self-closed void
 * elements), because the SVG image is parsed as XML.
 */
export function cardSvgDocument(
  cardHtml: string,
  css: string,
  width: number,
  height: number,
): string {
  const sheet = css.replace(/\]\]>/g, "]]]]><![CDATA[>");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><style type="text/css"><![CDATA[${sheet}]]></style></defs>` +
    `<foreignObject width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px">` +
    cardHtml +
    `</div></foreignObject></svg>`
  );
}

function loadImage(img: HTMLImageElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("capture: SVG image did not load within 8s"));
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(
        new Error(
          "capture: SVG image failed to load; cardHtml must be " +
            "XHTML-well-formed (balanced tags, quoted attributes, self-closed " +
            "void elements) because the SVG image is parsed as XML",
        ),
      );
    };
  });
}

/** Sampled luminance variance, the spike's blank-canvas discriminator. */
export function sampledLuminanceVariance(pixels: Uint8ClampedArray): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4 * 37) {
    const lum =
      0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    sum += lum;
    sumSq += lum * lum;
    n++;
  }
  if (n === 0) {
    return 0;
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function toPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("capture: canvas.toBlob returned no PNG blob"));
        return;
      }
      blob
        .arrayBuffer()
        .then((buffer) => resolve(new Uint8Array(buffer)))
        .catch(reject);
    }, "image/png");
  });
}

/**
 * Rasterise `cardHtml` styled by `css` at `width` x `height` and return the
 * PNG bytes with their sha256. Runs entirely offscreen inside the current
 * document: the font faces are registered through the FontFace API, the
 * canvas is never attached, and no window is opened.
 *
 * The SVG goes to the image as a data: URI. A blob: URL would taint the
 * canvas in both engines and every pixel read would throw.
 */
export async function captureCard(
  cardHtml: string,
  css: string,
  width: number,
  height: number,
): Promise<CaptureResult> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(`capture: bad canvas size ${width}x${height}`);
  }
  const faces = await warmFonts(css);
  try {
    const svg = cardSvgDocument(cardHtml, css, width, height);
    // The one line that matters: data:, never blob:. A blob: URL taints the
    // canvas in both engines and getImageData throws on every later read.
    const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const img = new Image();
    img.src = dataUri;
    await loadImage(img, 8000);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("capture: no 2d context on the capture canvas");
    }
    ctx.clearRect(0, 0, width, height);
    try {
      ctx.drawImage(img, 0, 0, width, height);
    } catch (e) {
      throw new Error(`capture: drawImage threw (${e})`);
    }

    let pixels: Uint8ClampedArray;
    try {
      pixels = ctx.getImageData(0, 0, width, height).data;
    } catch (e) {
      throw new Error(
        `capture: getImageData failed (${e}); the canvas is tainted. The ` +
          `SVG must reach the image through a data: URI, never blob:`,
      );
    }
    const variance = sampledLuminanceVariance(pixels);
    const png = await toPngBytes(canvas);
    return {
      height,
      png,
      pixelVariance: variance,
      sha256: sha256Hex(png),
      width,
    };
  } finally {
    for (const face of faces) {
      document.fonts.delete(face);
    }
  }
}
