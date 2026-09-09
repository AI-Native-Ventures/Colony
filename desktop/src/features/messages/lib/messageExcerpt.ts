/**
 * Keep the opening paragraphs of a long prose update on the reading surface.
 * Structured Markdown and attachments stay intact: a fold must never split a
 * code fence, table, list, media embed or an interactive work card.
 */
export function messageExcerpt(content: string): string | null {
  if (
    content.length < 900 ||
    /```|~~~|https?:\/\/|buzz:\/\/|!\[|<|\|/.test(content) ||
    /^\s*(?:[-*+]\s|\d+[.)]\s|>)/m.test(content)
  ) {
    return null;
  }
  const paragraphs = content.split(/\n\s*\n/);
  if (paragraphs.length < 3) return null;
  const opening: string[] = [];
  for (const paragraph of paragraphs.slice(0, -1)) {
    opening.push(paragraph);
    if (opening.join("\n\n").length >= 240) break;
  }
  const excerpt = opening.join("\n\n");
  return excerpt.length <= 700 && content.length - excerpt.length >= 240
    ? excerpt
    : null;
}
