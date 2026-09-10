import { MAX_DIAGRAM_SVG_BYTES } from "./diagramModel";

const NS = "http://www.w3.org/2000/svg";
const ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "marker",
]);
const ATTRIBUTES = new Set([
  "id",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
  "d",
  "points",
  "pathLength",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "color",
  "clip-path",
  "clip-rule",
  "vector-effect",
  "paint-order",
  "display",
  "visibility",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
  "word-spacing",
  "textLength",
  "lengthAdjust",
  "dx",
  "dy",
  "rotate",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "fx",
  "fy",
  "fr",
  "clipPathUnits",
  "markerWidth",
  "markerHeight",
  "refX",
  "refY",
  "orient",
  "markerUnits",
  "marker-start",
  "marker-mid",
  "marker-end",
  "role",
  "aria-label",
]);
const PAINT = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "color",
  "clip-path",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
  "word-spacing",
  "marker-start",
  "marker-mid",
  "marker-end",
  "stop-color",
  "stop-opacity",
];

function safeValue(value: string): string {
  const normalized = value.replace(
    /url\(["']?[^)"']*#([\w.-]+)["']?\)/g,
    "url(#$1)",
  );
  if (
    /[\\;]|\/\*|\*\/|(?:javascript|data|https?|file):|@/i.test(normalized) ||
    /url\((?!#[\w.-]+\))/i.test(normalized)
  ) {
    throw new Error("Diagram output contains an unsupported resource.");
  }
  return normalized;
}

function containsExternalResource(value: string): boolean {
  return /[\\]|\/\*|\*\/|@(?:import|font-face)|(?:javascript|data|https?|file):|url\((?!["']?#[\w.-]+["']?\))/i.test(
    value,
  );
}

/** Flatten library styling into the existing declarative SVG artwork vocabulary. */
export function flattenDiagramSvg(markup: string, host: HTMLElement): string {
  if (new TextEncoder().encode(markup).length > MAX_DIAGRAM_SVG_BYTES)
    throw new Error("Diagram output is too large.");
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.querySelector("parsererror"))
    throw new Error("Diagram output is invalid.");
  if (root.querySelectorAll("*").length >= 5_000)
    throw new Error("Diagram output is too complex.");
  // Mermaid adds unused computer/database/clock symbols to every sequence.
  // Drop those inert definitions; referenced icons and use/href remain unsupported.
  for (const symbol of root.querySelectorAll("defs > symbol")) {
    const id = symbol.getAttribute("id");
    if (id && markup.includes(`#${id}`))
      throw new Error("Diagram icons are not supported in this preview.");
    symbol.remove();
  }
  const all = [root, ...root.querySelectorAll("*")];
  for (const node of all) {
    if (
      node.namespaceURI !== NS ||
      (!ELEMENTS.has(node.localName) && node.localName !== "style")
    )
      throw new Error("Diagram output includes unsupported content.");
    if (
      [...node.attributes].some(
        (a) => /^on/i.test(a.name) || /href$/i.test(a.name),
      )
    )
      throw new Error("Diagram output includes an active link.");
    if (
      node.localName === "style" &&
      containsExternalResource(node.textContent || "")
    )
      throw new Error("Diagram styling includes an external resource.");
    for (const attribute of node.attributes) {
      if (attribute.name === "xmlns" && attribute.value === NS) continue;
      if (
        attribute.name === "xmlns:xlink" &&
        attribute.value === "http://www.w3.org/1999/xlink"
      )
        continue;
      if (containsExternalResource(attribute.value))
        throw new Error("Diagram styling includes an external resource.");
    }
  }
  const mounted = document.importNode(root, true);
  host.append(mounted);
  try {
    const copy = (node: Element, depth: number): Element | null => {
      if (node.localName === "style") return null;
      if (depth > 64) throw new Error("Diagram output is too deeply nested.");
      const result = document.createElementNS(NS, node.localName);
      for (const attr of node.attributes) {
        if (ATTRIBUTES.has(attr.name))
          result.setAttribute(attr.name, safeValue(attr.value));
      }
      const computed = getComputedStyle(node);
      for (const property of PAINT) {
        const value = computed.getPropertyValue(property).trim();
        if (value) result.setAttribute(property, safeValue(value));
      }
      for (const child of node.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const element = copy(child as Element, depth + 1);
          if (element) result.append(element);
        } else if (
          child.nodeType === Node.TEXT_NODE &&
          ["text", "tspan", "title", "desc"].includes(node.localName)
        ) {
          result.append(document.createTextNode(child.textContent || ""));
        }
      }
      return result;
    };
    const output = copy(mounted, 0);
    if (!output) throw new Error("Diagram output is empty.");
    output.setAttribute("xmlns", NS);
    const box = mounted
      .getAttribute("viewBox")
      ?.trim()
      .split(/[ ,]+/)
      .map(Number);
    if (
      box?.length !== 4 ||
      box.some((n) => !Number.isFinite(n)) ||
      box[2] <= 0 ||
      box[3] <= 0 ||
      box[2] > 8192 ||
      box[3] > 8192
    )
      throw new Error("Diagram dimensions exceed the preview limit.");
    output.setAttribute("width", String(box[2]));
    output.setAttribute("height", String(box[3]));
    const svg = new XMLSerializer().serializeToString(output);
    if (new TextEncoder().encode(svg).length > MAX_DIAGRAM_SVG_BYTES)
      throw new Error("Diagram output is too large.");
    return svg;
  } finally {
    mounted.remove();
  }
}
