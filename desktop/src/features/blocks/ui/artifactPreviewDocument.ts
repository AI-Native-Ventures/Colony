const MAX_HTML_LENGTH = 20_000;
const ALLOWED_ELEMENTS = new Set(
  "html head body title style main header footer nav section article aside div span p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd strong em b i small br hr blockquote pre code table thead tbody tfoot tr th td caption figure figcaption img a".split(
    " ",
  ),
);
const ALLOWED_ATTRIBUTES = new Set(
  "class id style title alt width height colspan rowspan lang dir role".split(
    " ",
  ),
);

/** A static artifact gets no scripts, navigation, forms, or network access. */
export function artifactPreviewDocument(html: string): string {
  if (!html.trim() || html.length > MAX_HTML_LENGTH) {
    throw new Error("The HTML preview is empty or exceeds 20,000 characters.");
  }
  const previewDocument = document.implementation.createHTMLDocument("");
  const template = previewDocument.createElement("template");
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll("*")) {
    if (!ALLOWED_ELEMENTS.has(element.localName)) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      if (!ALLOWED_ATTRIBUTES.has(attribute.name)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  previewDocument.body.append(template.content);
  const policy = previewDocument.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'";
  previewDocument.head.prepend(policy);
  const viewport = previewDocument.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  previewDocument.head.append(viewport);
  return `<!doctype html>${previewDocument.documentElement.outerHTML}`;
}

/** Optional preview fields do not change older artifact rendering. */
export function readArtifactHtml(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const html = (data as Record<string, unknown>).preview_html;
  return typeof html === "string" ? html : null;
}
