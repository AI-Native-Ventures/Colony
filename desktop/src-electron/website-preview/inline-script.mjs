/**
 * Verified inline content authorization for the preview CSP.
 *
 * Generated static sites often carry inline `<script>` blocks. Blocking them
 * outright would ship a broken interactive preview, so instead the host scans
 * each verified HTML document as it is served and authorizes exactly those
 * bytes by hash. Nothing here executes or evaluates content: it only computes
 * SHA-256 tokens for the bytes the loader already verified. Inline scripts
 * that were not in a verified document, or that the loader did not serve,
 * still fail.
 *
 * The scan is byte-exact: the HTML is indexed as latin1 (one character per
 * byte), so `Buffer.subarray` offsets are the real byte offsets and hashes
 * cover the bytes as served even when the document is not valid UTF-8.
 */

import { createHash } from "node:crypto";

/** Upper bound on authorized inline tokens per entrypoint. */
export const MAX_INLINE_AUTHORIZATIONS = 128;

const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>/gi;
const SRC_ATTRIBUTE_PATTERN = /\bsrc\s*=/i;
const EVENT_HANDLER_PATTERN = /\son[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const NUMERIC_ENTITY_PATTERN = /&#(x[0-9a-f]{1,6}|\d{1,7});/gi;

function hashToken(bytes) {
  const digest = createHash("sha256").update(bytes).digest("base64");
  return `'sha256-${digest}'`;
}

/**
 * Decode the small entity set that can appear in a quoted event-handler
 * attribute. Numeric entities outside Unicode are replaced with U+FFFD, the
 * same as HTML parsing. Returns `null` when the value cannot be reproduced,
 * which leaves that one handler blocked rather than opening the document.
 */
function decodeAttributeValue(value) {
  try {
    return value
      .replace(NUMERIC_ENTITY_PATTERN, (_match, code) => {
        const parsed = code.startsWith("x")
          ? Number.parseInt(code.slice(1), 16)
          : Number.parseInt(code, 10);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0x10ffff) {
          return "\uFFFD";
        }
        return String.fromCodePoint(parsed);
      })
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  } catch {
    return null;
  }
}

/**
 * Collect CSP authorizations for one verified HTML document's bytes.
 *
 * Returns `{ scriptHashes, handlerHashes, truncated }`, where each entry is a
 * formatted `'sha256-...'` source expression. Only the first
 * `MAX_INLINE_AUTHORIZATIONS` tokens are returned; `truncated` tells the host
 * that further inline scripts stay blocked (a safe, visible degradation).
 */
export function collectInlineAuthorizations(
  bytes,
  limit = MAX_INLINE_AUTHORIZATIONS,
) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("document bytes must be a Uint8Array");
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("limit must be a positive integer");
  }
  const text = Buffer.from(bytes).toString("latin1");
  const scriptHashes = [];
  const seenScripts = new Set();
  const closePattern = /<\/script\b/gi;
  let truncated = false;

  for (const match of text.matchAll(SCRIPT_TAG_PATTERN)) {
    if (SRC_ATTRIBUTE_PATTERN.test(match[1])) continue;
    const contentStart = match.index + match[0].length;
    closePattern.lastIndex = contentStart;
    const close = closePattern.exec(text);
    if (close === null) break;
    if (scriptHashes.length >= limit) {
      truncated = true;
      break;
    }
    const token = hashToken(bytes.subarray(contentStart, close.index));
    if (seenScripts.has(token)) continue;
    seenScripts.add(token);
    scriptHashes.push(token);
  }

  const handlerHashes = [];
  const seenHandlers = new Set();
  for (const match of text.matchAll(EVENT_HANDLER_PATTERN)) {
    if (handlerHashes.length >= limit) {
      truncated = true;
      break;
    }
    const value = decodeAttributeValue(match[1] ?? match[2]);
    if (value === null) continue;
    const token = hashToken(Buffer.from(value, "utf8"));
    if (seenHandlers.has(token)) continue;
    seenHandlers.add(token);
    handlerHashes.push(token);
  }

  return Object.freeze({
    scriptHashes: Object.freeze(scriptHashes),
    handlerHashes: Object.freeze(handlerHashes),
    truncated,
  });
}
