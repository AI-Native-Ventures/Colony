import {
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_SOURCE_BYTES,
  validateDiagramSource,
} from "./diagramModel";
import { flattenDiagramSvg } from "./diagramSvg";

export type DiagramPalette = {
  dark: boolean;
  background: string;
  foreground: string;
  accent: string;
  muted: string;
  surface: string;
  border: string;
};
let library: Promise<typeof import("mermaid")> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

/** Serialized renders isolate Mermaid's global configuration; no content is cached. */
export function renderDiagram(
  source: string,
  palette: DiagramPalette,
  signal: AbortSignal,
): Promise<string> {
  const text = validateDiagramSource(source);
  const operation = queue
    .catch(() => {})
    .then(async () => {
      if (signal.aborted) throw new Error("Diagram preview cancelled.");
      library ||= import("mermaid").catch((error: unknown) => {
        library = undefined;
        throw error;
      });
      const { default: mermaid } = await library;
      if (signal.aborted) throw new Error("Diagram preview cancelled.");
      const host = document.createElement("div");
      host.style.cssText =
        "position:fixed;left:-20000px;top:0;width:1200px;visibility:hidden;pointer-events:none";
      document.body.append(host);
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          maxTextSize: MAX_DIAGRAM_SOURCE_BYTES,
          maxEdges: MAX_DIAGRAM_EDGES,
          theme: "base",
          layout: "dagre",
          htmlLabels: false,
          fontFamily: "Arial, sans-serif",
          themeVariables: {
            darkMode: palette.dark,
            fontFamily: "Arial, sans-serif",
            fontSize: getComputedStyle(document.documentElement).fontSize,
            background: palette.background,
            mainBkg: palette.background,
            primaryColor: palette.surface,
            primaryTextColor: palette.foreground,
            primaryBorderColor: palette.accent,
            secondaryColor: palette.surface,
            tertiaryColor: palette.background,
            textColor: palette.foreground,
            lineColor: palette.muted,
            nodeBorder: palette.accent,
            clusterBkg: palette.surface,
            clusterBorder: palette.border,
            edgeLabelBackground: palette.background,
            actorBkg: palette.surface,
            actorBorder: palette.accent,
            actorTextColor: palette.foreground,
            actorLineColor: palette.muted,
            signalColor: palette.foreground,
            signalTextColor: palette.foreground,
            labelBoxBkgColor: palette.background,
            labelBoxBorderColor: palette.border,
            labelTextColor: palette.foreground,
            loopTextColor: palette.foreground,
            noteBkgColor: palette.surface,
            noteTextColor: palette.foreground,
            noteBorderColor: palette.accent,
          },
          flowchart: {
            htmlLabels: false,
            useMaxWidth: false,
            curve: "basis",
            nodeSpacing: 30,
            rankSpacing: 40,
          },
          sequence: { useMaxWidth: false, actorMargin: 40, messageMargin: 30 },
          er: { useMaxWidth: false },
        });
        const result = await mermaid.render(
          `colony-diagram-${++counter}`,
          text,
          host,
        );
        if (signal.aborted) throw new Error("Diagram preview cancelled.");
        return flattenDiagramSvg(result.svg, host);
      } finally {
        host.remove();
      }
    });
  queue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
