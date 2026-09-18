import { zip } from "fflate";
import { createHash } from "node:crypto";
import { validateAssetPath, MAX_TOTAL_BYTES, MAX_PREVIEW_FILES } from "./manifest.mjs";

/** Archive the exact verified browser-ready files, without executing their code. */
export async function createWebsiteHandover(site, identity, approvalEvent) {
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
  let approval = null;
  if (approvalEvent !== undefined) {
    // The trusted app renderer has verified the owner signature. Preserve the
    // original wire record for independent verification; do not mint an attestation.
    const event = approvalEvent;
    if (!event || event.kind !== 40010 || !/^[0-9a-f]{64}$/.test(event.pubkey)
        || !/^[0-9a-f]{128}$/.test(event.sig) || !Array.isArray(event.tags)
        || !Number.isSafeInteger(event.created_at) || typeof event.content !== "string"
        || Buffer.byteLength(JSON.stringify(event)) > 16_384) {
      throw new Error("Invalid approval record");
    }
    const wire = { id: event.id, pubkey: event.pubkey, created_at: event.created_at,
      kind: event.kind, tags: event.tags, content: event.content, sig: event.sig };
    const digest = createHash("sha256").update(JSON.stringify([
      0, wire.pubkey, wire.created_at, wire.kind, wire.tags, wire.content,
    ])).digest("hex");
    const input = JSON.parse(wire.content);
    const targets = wire.tags.filter((tag) => tag[0] === "e" && tag[3] === "block-instance");
    const actions = wire.tags.filter((tag) => tag[0] === "block-action");
    if (digest !== wire.id || targets.length !== 1 || targets[0][1] !== identity.artifactId
        || actions.length !== 1 || actions[0][2] !== "artifact.approve-design"
        || input.scope !== "design-only" || input.revision !== identity.revision
        || input.manifest_sha256 !== site.manifestSha256) {
      throw new Error("Approval record does not match this saved website");
    }
    entries["design-approval.json"] = new TextEncoder().encode(JSON.stringify(wire, null, 2));
    approval = { eventId: wire.id, path: "design-approval.json", scope: "design-only" };
  }
  entries["colony-handover.json"] = new TextEncoder().encode(JSON.stringify({
    schema: "colony.website-handover/1", artifactId: identity.artifactId,
    revision: identity.revision, manifestSha256: site.manifestSha256,
    entrypoint: `website/${site.entrypoint}`, files: hashes, sourceArchive, approval,
    description: "Exact browser-ready preview files. A source archive is included only when listed in sourceArchive; its integrity is verified, not its completeness or functionality. Backend services are not provisioned. This archive does not publish a website or grant publication permission.",
  }, null, 2));
  return new Promise((resolve, reject) => {
    zip(entries, { level: 0 }, (error, bytes) => error ? reject(error) : resolve(bytes));
  });
}
