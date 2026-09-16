import { zip } from "fflate";
import { createHash } from "node:crypto";
import { validateAssetPath, MAX_TOTAL_BYTES, MAX_PREVIEW_FILES } from "./manifest.mjs";

/** Archive the exact verified browser-ready files, without executing their code. */
export async function createWebsiteHandover(site, identity) {
  if (!/^[0-9a-f]{64}$/.test(identity.artifactId)
      || !Number.isSafeInteger(identity.revision) || identity.revision < 1
      || !/^[0-9a-f]{64}$/.test(site.manifestSha256)
      || site.files.length > MAX_PREVIEW_FILES) {
    throw new Error("Invalid saved website identity");
  }
  const entries = Object.create(null);
  const hashes = [];
  let total = 0;
  for (const descriptor of site.files) {
    validateAssetPath(descriptor.path);
    const key = `website/${descriptor.path}`;
    if (Object.hasOwn(entries, key)) throw new Error("Duplicate website file");
    const file = site.getFile(descriptor.path);
    if (!file || file.bytes.length !== descriptor.size) throw new Error("Missing website bytes");
    const digest = createHash("sha256").update(file.bytes).digest("hex");
    if (digest !== descriptor.sha256) throw new Error("Website bytes changed since review");
    total += file.bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("Website handover is too large");
    entries[key] = new Uint8Array(file.bytes);
    hashes.push({ path: descriptor.path, sha256: digest, size: file.bytes.length });
  }
  let sourceArchive = null;
  if (site.sourceArchive) {
    const bytes = site.getSourceArchive?.();
    if (!bytes || bytes.length !== site.sourceArchive.size
        || createHash("sha256").update(bytes).digest("hex") !== site.sourceArchive.sha256) {
      throw new Error("Source archive changed since review");
    }
    if (total + bytes.length > MAX_TOTAL_BYTES) throw new Error("Website handover is too large");
    entries["source/project.zip"] = new Uint8Array(bytes);
    sourceArchive = { path: "source/project.zip", sha256: site.sourceArchive.sha256, size: bytes.length };
  }
  entries["colony-handover.json"] = new TextEncoder().encode(JSON.stringify({
    schema: "colony.website-handover/1", artifactId: identity.artifactId,
    revision: identity.revision, manifestSha256: site.manifestSha256,
    entrypoint: `website/${site.entrypoint}`, files: hashes, sourceArchive,
    description: "Exact browser-ready preview files. A source archive is included only when listed in sourceArchive; its integrity is verified, not its completeness or functionality. Backend services are not provisioned. This archive does not publish a website or grant publication permission.",
  }, null, 2));
  return new Promise((resolve, reject) => {
    zip(entries, { level: 0 }, (error, bytes) => error ? reject(error) : resolve(bytes));
  });
}
