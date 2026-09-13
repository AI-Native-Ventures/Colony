import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const resourceDir = fileURLToPath(
  new URL("../src-tauri/resources/dictation/", import.meta.url),
);
export const modelManifest = JSON.parse(
  await readFile(new URL("../dictation-model.json", import.meta.url), "utf8"),
);

export async function verifyModel(file, manifest = modelManifest) {
  if ((await stat(file)).size !== manifest.bytes)
    throw new Error("Dictation model size mismatch");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== manifest.sha256)
    throw new Error("Dictation model checksum mismatch");
}

export async function stageModel({
  directory = resourceDir,
  manifest = modelManifest,
  fetchModel = fetch,
} = {}) {
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, manifest.filename);
  try {
    await verifyModel(destination, manifest);
    return destination;
  } catch {
    /* Missing or corrupt cache: replace only after verification. */
  }
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.partial`;
  try {
    const response = await fetchModel(manifest.url, {
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok || !response.body)
      throw new Error(`Dictation model download failed: ${response.status}`);
    const output = await open(temporary, "wx");
    try {
      let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > manifest.bytes)
          throw new Error("Dictation model exceeds expected size");
        await output.writeFile(chunk);
      }
    } finally {
      await output.close();
    }
    await verifyModel(temporary, manifest);
    await rename(temporary, destination);
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(`Verified bundled dictation model: ${await stageModel()}`);
}
