import assert from "node:assert/strict";
import test from "node:test";
import {
  diagramDownloadName,
  supportsDiagramFile,
  validateDiagramSource,
  MAX_DIAGRAM_SOURCE_BYTES,
} from "./diagramModel.ts";
import { DIAGRAM_EXAMPLES } from "./diagramExamples.ts";

test("approved complex flow, sequence and relationship sources pass the viewer boundary", () => {
  for (const example of DIAGRAM_EXAMPLES)
    assert.equal(validateDiagramSource(example.source), example.source);
  assert.equal(
    validateDiagramSource(
      "flowchart TB\naccTitle: A useful description\nA --> B",
    ),
    "flowchart TB\naccTitle: A useful description\nA --> B",
  );
});
test("source configuration, active labels, image shapes and link callbacks never load the renderer", () => {
  for (const text of [
    "%%{init: {}}%%\nflowchart LR\nA-->B",
    "---\nconfig: {}\n---\nflowchart LR\nA-->B",
    'flowchart LR;click A "https://example.com"',
    "flowchart LR;style A fill:red",
    "flowchart LR\nA[<img src='/private'>]",
    "flowchart LR\nA@{img: '/private'}",
    "flowchart LR\nA[javascript:alert]",
    "sequenceDiagram\nrect url(/private)\nA->>B: hello\nend",
    "sequenceDiagram\nrect url(//host/path)\nA->>B: hello\nend",
    "sequenceDiagram\nrect u\\72l(/private)\nA->>B: hello\nend",
    "sequenceDiagram\nlink Actor: Label @ /private",
    "pie\nA:3",
  ])
    assert.throws(() => validateDiagramSource(text));
});
test("empty and oversized sources preserve a bounded failure instead of invoking layout", () => {
  for (const text of [
    "",
    `flowchart LR\n${"a".repeat(MAX_DIAGRAM_SOURCE_BYTES)}`,
    `flowchart LR\n${"%% comment\n".repeat(201)}`,
  ])
    assert.throws(() => validateDiagramSource(text));
});
test("diagram routing never promotes HTML and source download names stay filenames", () => {
  assert.equal(supportsDiagramFile("plan.MMD", "text/plain"), true);
  assert.equal(
    supportsDiagramFile("attachment", "text/vnd.mermaid; charset=utf-8"),
    true,
  );
  assert.equal(supportsDiagramFile("plan.mmd", "text/html"), false);
  assert.equal(supportsDiagramFile("plan.mmd", "application/xhtml+xml"), false);
  assert.equal(supportsDiagramFile("plan.pdf", "application/pdf"), false);
  assert.equal(diagramDownloadName("../plan.mmd", "svg"), "plan.svg");
  assert.equal(diagramDownloadName("bad\u0000name.mmd", "mmd"), "bad_name.mmd");
});
