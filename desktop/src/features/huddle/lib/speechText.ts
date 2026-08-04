/**
 * Convert an agent's markdown chat message into text fit for a TTS engine.
 *
 * Huddle TTS pipes raw `kind:9` content into synthesis, and agents write
 * markdown - so headings were spoken as "hash hash", emphasis as "asterisk",
 * links as full URLs. Speech wants the words, not the markup.
 *
 * Code blocks are not speakable at all: they are removed, and a message that
 * was only code collapses to a short spoken notice instead of silence (a
 * silent turn in a voice call reads as the agent not responding).
 */

const FENCED_CODE = /(?:```|~~~)[\s\S]*?(?:```|~~~)|(?:```|~~~)[\s\S]*$/g;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]+)\]\([^)]*\)/g;
const BARE_URI = /\b(?:https?:\/\/|nostr:|buzz:\/\/)\S+/g;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
const HEADING = /^#{1,6}\s+/gm;
const BLOCKQUOTE = /^\s*(?:>\s?)+/gm;
const BULLET = /^(\s*)[-*+]\s+/gm;
const ORDERED_PAREN = /^(\s*\d+)\)\s+/gm;
const HRULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm;
const TABLE_SEPARATOR = /^\s*\|?[\s|:-]+\|[\s|:-]*$\n?/gm;
const BOLD = /\*\*([^*]+)\*\*|__([^_]+)__/g;
const ITALIC_STAR = /\*([^*\n]+)\*/g;
const ITALIC_UNDERSCORE = /(^|\W)_([^_\n]+)_(?=\W|$)/g;
const STRIKETHROUGH = /~~([^~]+)~~/g;
const INLINE_CODE = /`([^`\n]*)`/g;

export const CODE_ONLY_SPOKEN_NOTICE = "I posted a code snippet in the chat.";

/**
 * The spoken form of a markdown message. Empty string means there is nothing
 * worth saying and the caller should skip synthesis entirely.
 */
export function toSpeechText(markdown: string): string {
  const hadCode = /```|~~~/.test(markdown);

  let text = markdown
    .replace(FENCED_CODE, " ")
    .replace(IMAGE, "$1")
    .replace(LINK, "$1")
    .replace(BARE_URI, "")
    .replace(HTML_TAG, " ")
    .replace(TABLE_SEPARATOR, "")
    .replace(HRULE, "")
    .replace(HEADING, "")
    .replace(BLOCKQUOTE, "")
    .replace(BULLET, "$1")
    .replace(ORDERED_PAREN, "$1. ")
    .replace(BOLD, "$1$2")
    .replace(ITALIC_STAR, "$1")
    .replace(ITALIC_UNDERSCORE, "$1$2")
    .replace(STRIKETHROUGH, "$1")
    .replace(INLINE_CODE, "$1");

  // Table body rows: pipes become clause breaks so a row reads as a sentence.
  text = text
    .split("\n")
    .map((line) =>
      line.trim().startsWith("|")
        ? line
            .split("|")
            .map((cell) => cell.trim())
            .filter((cell) => cell.length > 0)
            .join(", ")
        : line,
    )
    .join("\n");

  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length === 0) {
    return hadCode ? CODE_ONLY_SPOKEN_NOTICE : "";
  }
  return text;
}
