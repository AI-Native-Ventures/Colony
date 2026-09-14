export const MENTION_CHIP_BASE_CLASSES = "mention-chip";

export const MENTION_CHIP_HOVER_CLASSES = "mention-chip-hover";

export type InlineChipIconKind =
  | "agent"
  | "human"
  | "channel"
  | "message"
  | "repo"
  | "pr"
  | "issue";

const INLINE_CHIP_ICON_KIND_CLASSES: Record<InlineChipIconKind, string> = {
  agent: "inline-chip-icon-agent agent-mention-highlight",
  human: "inline-chip-icon-human human-mention-highlight",
  channel: "inline-chip-icon-channel",
  message: "inline-chip-icon-message",
  repo: "inline-chip-icon-repo",
  pr: "inline-chip-icon-pr",
  issue: "inline-chip-icon-issue",
};

/** Shared icon-box contract for React chips and ProseMirror decorations. */
export function inlineChipIconClasses(kind: InlineChipIconKind): string {
  return `inline-chip-with-icon ${INLINE_CHIP_ICON_KIND_CLASSES[kind]}`;
}

/** Wrapper on rendered message Markdown — scopes inline chip CSS. */
export const MESSAGE_MARKDOWN_CLASS = "message-markdown";

/** Inline `` `code` `` chip — matches mention chip rhythm in message bodies. */
export const INLINE_CODE_CHIP_CLASS = "inline-code-chip";

// Grapheme-bounded inline chip labels. Upstream added these with its
// fragmentable chip rendering; Colony does not carry that commit, and #7228's
// clipboard code needs the cap, so the two helpers land here with it.
const INLINE_CHIP_LABEL_MAX_CHARACTERS = 48;

const inlineChipGraphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function inlineChipGraphemes(label: string): string[] {
  return inlineChipGraphemeSegmenter
    ? Array.from(
        inlineChipGraphemeSegmenter.segment(label),
        ({ segment }) => segment,
      )
    : Array.from(label);
}

/** Caps a fragmentable chip label without changing its underlying metadata. */
export function truncateInlineChipLabel(label: string): string {
  const graphemes = inlineChipGraphemes(label);
  if (graphemes.length <= INLINE_CHIP_LABEL_MAX_CHARACTERS) return label;
  return `${graphemes.slice(0, INLINE_CHIP_LABEL_MAX_CHARACTERS - 1).join("")}…`;
}
