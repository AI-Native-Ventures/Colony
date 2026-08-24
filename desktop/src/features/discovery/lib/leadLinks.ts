/**
 * Turning a lead's stored contact details into links that are safe to open.
 *
 * Discovery sources write whatever the provider gave them, so a website can
 * arrive as `https://acme.example`, as a bare `acme.example`, or as something
 * that is not a web address at all. A bare host resolves against the app's own
 * origin, and a `javascript:` or `file:` value handed to the native opener is a
 * way out of the webview, so both are decided here rather than at each call
 * site.
 */

/** The only schemes a lead's website or profile link may use. */
const WEB_SCHEMES = new Set(["http:", "https:"]);

/**
 * The absolute `http(s)` URL for a lead's website or profile, or `null`.
 *
 * A value with no scheme is treated as a host and promoted to `https:`. Any
 * other scheme is refused outright: nothing else is a web page, and passing
 * one to the OS opener would run it.
 */
export function leadWebUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!WEB_SCHEMES.has(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  return parsed.toString();
}

/** The `mailto:` URL for a lead's email address, or `null`. */
export function leadMailtoUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed?.includes("@") || /\s/.test(trimmed)) return null;
  return `mailto:${encodeURIComponent(trimmed).replace(/%40/g, "@")}`;
}

/** The `tel:` URL for a lead's phone number, or `null`. */
export function leadTelUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const dialable = trimmed.replace(/[^\d+]/g, "");
  return dialable.replace(/\D/g, "").length > 0 ? `tel:${dialable}` : null;
}
