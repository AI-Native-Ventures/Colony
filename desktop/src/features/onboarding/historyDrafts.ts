/** Local extraction never treats transcript text as executable instructions. */
export type HistoryFile = { source: string; name: string; text: string };
export type MemoryDraft = {
  id: string;
  text: string;
  source: string;
  file: string;
  date: string;
  keep: boolean;
};
const secret =
  /(?:\b(?:sk-|ghp_|github_pat_|xox[baprs]-|AKIA|nsec1|ncryptsec1)[a-zA-Z0-9_-]{8,}|-----BEGIN .*PRIVATE KEY|(?:password|api[_ -]?key|access[_ -]?token|secret)\s*[:=])/i;
const sensitive =
  /\b(?:diagnos|medication|religion|sexual|passport|social security|bank account|credit card)/i;
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) =>
        typeof part === "string"
          ? part
          : part?.type === "text" || part?.type === "input_text"
            ? part.text
            : "",
      )
      .join("\n");
  return "";
}
/** Accept only known user-message schemas, never tool results or assistant claims. */
export function userStatements(
  file: HistoryFile,
): { text: string; date: string }[] {
  const result: { text: string; date: string }[] = [];
  const add = (text: unknown, date: unknown) => {
    const content = textContent(text);
    if (content)
      result.push({
        text: content,
        date: typeof date === "string" ? date.slice(0, 10) : "",
      });
  };
  if (file.name.endsWith(".md")) {
    return [
      {
        text: file.text
          .split("\n")
          .map((line) => line.replace(/^[-*]\s+/, ""))
          .join("\n"),
        date: "",
      },
    ];
  }
  if (["codex", "claude", "hermes", "openclaw"].includes(file.source)) {
    for (const line of file.text.split("\n")) {
      if (!line.trim()) continue;
      let row: {
        type?: string;
        timestamp?: string;
        isMeta?: boolean;
        payload?: { type?: string; role?: string; content?: unknown };
        message?: { role?: string; content?: unknown };
      };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        file.source === "codex" &&
        row.type === "response_item" &&
        row.payload?.type === "message" &&
        row.payload.role === "user"
      )
        add(row.payload.content, row.timestamp);
      if (
        (file.source === "claude" ||
          file.source === "hermes" ||
          file.source === "openclaw") &&
        (row.type === "user" ||
          (file.source === "openclaw" && row.type === "message")) &&
        row.message?.role === "user" &&
        !row.isMeta
      )
        add(row.message.content, row.timestamp);
    }
  } else {
    const parsed = JSON.parse(file.text);
    if (!Array.isArray(parsed))
      throw new Error("Choose a ChatGPT or Claude conversations JSON export.");
    for (const conversation of parsed) {
      if (conversation.mapping)
        for (const node of Object.values(conversation.mapping) as {
          message?: {
            author?: { role?: string };
            content?: { parts?: unknown };
            create_time?: number;
          };
        }[]) {
          const m = node?.message;
          if (m?.author?.role === "user")
            add(
              m.content?.parts,
              typeof m.create_time === "number"
                ? new Date(m.create_time * 1000).toISOString()
                : "",
            );
        }
      if (Array.isArray(conversation.chat_messages))
        for (const m of conversation.chat_messages)
          if (m.sender === "human") add(m.text, m.created_at);
    }
  }
  return result;
}
/** Draft explicit first-person preferences and context, with owner review required. */
export async function draftHistoryMemories(
  files: HistoryFile[],
): Promise<MemoryDraft[]> {
  const drafts: MemoryDraft[] = [];
  const seen = new Set<string>();
  for (const file of files)
    for (const message of userStatements(file)) {
      // Quoted content, structured tool context and pasted instruction blocks are excluded.
      if (
        message.text.includes("<") ||
        message.text.includes("```") ||
        message.text.length > 6000
      )
        continue;
      for (const sentence of message.text.split(/\n|(?<=[.!?])\s+/)) {
        const text = sentence.trim();
        if (
          !/^(?:I (?:prefer|like|work|run|own|manage|use|want|need|am|live)|My (?:name|business|company|team|goal|project|preferred)|We (?:run|sell|provide|work|use|are))\b/i.test(
            text,
          ) ||
          text.length < 15 ||
          text.length > 500 ||
          secret.test(text) ||
          sensitive.test(text)
        )
          continue;
        const normalized = text.toLowerCase().replace(/\s+/g, " ");
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(normalized),
        );
        drafts.push({
          id: Array.from(new Uint8Array(digest), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join(""),
          text,
          source: file.source,
          file: file.name,
          date: message.date,
          keep: file.source !== "openclaw" && !file.name.endsWith(".md"),
        });
        if (drafts.length >= 50) return drafts;
      }
    }
  return drafts;
}
