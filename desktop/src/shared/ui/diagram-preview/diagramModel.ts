/** Limits apply before loading a diagramming library or reading diagram geometry. */
export const MAX_DIAGRAM_SOURCE_BYTES = 16_384;
export const MAX_DIAGRAM_LINES = 200;
export const MAX_DIAGRAM_EDGES = 150;
export const MAX_DIAGRAM_SVG_BYTES = 2 * 1024 * 1024;

/** Diagram files use the existing attachment transport, never executable HTML. */
export function supportsDiagramFile(filename: string, mime = ""): boolean {
  if (
    ["text/html", "application/xhtml+xml"].includes(
      mime.split(";")[0].trim().toLowerCase(),
    )
  )
    return false;
  return (
    /\.(?:mmd|mermaid)$/i.test(filename) ||
    mime.split(";")[0].trim().toLowerCase() === "text/vnd.mermaid"
  );
}

/** Accept a bounded diagram definition without source-controlled styling or callbacks. */
export function validateDiagramSource(source: string): string {
  const text = source.trim();
  if (!text) throw new Error("This diagram has no content.");
  if (
    new TextEncoder().encode(text).length > MAX_DIAGRAM_SOURCE_BYTES ||
    text.split("\n").length > MAX_DIAGRAM_LINES
  ) {
    throw new Error(
      "This diagram is too large for an inline preview. Download the source to open it elsewhere.",
    );
  }
  if (
    /%%\s*\{|^---|<\/?[a-z!]|(?:javascript|data|https?|file):|@import|@font-face|@\s*\{|url\s*\(|\/\*|\*\/|\\/i.test(
      text,
    ) ||
    /(?:^|[;\n])\s*(?:click|style|classDef|linkStyle|link|links|properties|details|rect)(?:\s|:)/i.test(
      text,
    )
  ) {
    throw new Error(
      "This diagram includes links, markup or custom configuration that cannot run in an inline preview.",
    );
  }
  const first =
    text
      .split("\n")
      .find((line) => line.trim() && !line.trim().startsWith("%%"))
      ?.trim() || "";
  if (
    !/^(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b/.test(first) &&
    !/^(?:sequenceDiagram|erDiagram)\s*$/.test(first)
  ) {
    throw new Error(
      "Inline diagrams currently support flowcharts, sequences and entity relationships.",
    );
  }
  return text;
}

/** Keep download names predictable without treating supplied filenames as paths. */
export function diagramDownloadName(
  filename: string,
  extension: "mmd" | "svg",
): string {
  const name =
    filename
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.(?:mmd|mermaid|svg)$/i, "") || "diagram";
  return `${Array.from(name, (character) => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? "_" : character)).join("")}.${extension}`;
}
