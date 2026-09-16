/** Facts signed by the owner for design review; never publication permission. */
export function websiteDesignInput(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  const bundle = value.website_bundle;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
    return null;
  const digest = (bundle as Record<string, unknown>).sha256;
  if (
    value.status !== "ready-for-review" ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(digest)
  )
    return null;
  return {
    scope: "design-only",
    revision: value.revision,
    manifest_sha256: digest,
  };
}
