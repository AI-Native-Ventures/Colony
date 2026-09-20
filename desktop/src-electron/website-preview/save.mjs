import { writeFile } from "node:fs/promises";

/** Save verified archive bytes only after native path selection in the active context. */
export function createHandoverSaver(window, dialog) {
  return async (bytes, filename, active) => {
    if (!active()) throw new Error("Preview changed; reopen the website before saving");
    const result = await dialog.showSaveDialog(window, {
      title: "Save website files", defaultPath: filename,
      filters: [{ name: "Website archive", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    if (!active()) throw new Error("Community changed; reopen the website before saving");
    await writeFile(result.filePath, bytes);
    return { saved: true };
  };
}
