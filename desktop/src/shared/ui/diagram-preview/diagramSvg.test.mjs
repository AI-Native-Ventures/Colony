import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { flattenDiagramSvg } from "./diagramSvg.ts";

const dom = new JSDOM("<!doctype html><body></body>");
for (const name of ["document", "DOMParser", "XMLSerializer", "Node"])
  globalThis[name] = dom.window[name];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
after(() => dom.window.close());

const shadow = (small = false) =>
  `<defs><filter id="colony-diagram-1-drop-shadow${small ? "-small" : ""}" height="${small ? "150%" : "130%"}" width="${small ? "150%" : "130%"}"><feDropShadow dx="${small ? "2" : "4"}" dy="${small ? "2" : "4"}" stdDeviation="0" flood-opacity="0.06" flood-color="#000000"/></filter></defs>`;
const svg = (content) =>
  `<svg xmlns="http://www.w3.org/2000/svg" id="colony-diagram-1" viewBox="0 0 100 100">${content}<text x="10" y="20">Campaign</text></svg>`;
const flatten = (content) =>
  flattenDiagramSvg(svg(content), document.createElement("div"));

test("unused Mermaid 11.17 flow and ER shadows do not reject a valid diagram", () => {
  const result = flatten(shadow() + shadow(true));
  assert.match(result, /Campaign/);
  assert.doesNotMatch(result, /filter|feDropShadow|drop-shadow/);
});

test("referenced, modified and arbitrary filters remain unsupported", () => {
  for (const content of [
    `${shadow()}<g filter="url(#colony-diagram-1-drop-shadow)"/>`,
    `${shadow()}<style>g { filter: url(#colony-diagram-1-drop-shadow); }</style>`,
    shadow().replace('dx="4"', 'dx="5"'),
    shadow().replace('height="130%"', 'height="130%" onload="alert(1)"'),
    shadow().replace("feDropShadow", "feImage"),
    shadow().replace("colony-diagram-1-drop-shadow", "other-filter"),
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">HTML</div></foreignObject>',
  ])
    assert.throws(() => flatten(content), /unsupported content/);
});
