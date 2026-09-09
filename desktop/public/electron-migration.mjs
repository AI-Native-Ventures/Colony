import {
  collectLegacyState,
  importLegacyState,
  MIGRATION_MARKER,
} from "./electron-migration-state.mjs";

window.__COLONY_FRONTEND_MIGRATION__ = (async () => {
  if (
    window.colonyDesktop &&
    location.href === "colony://app/electron-migration.html"
  ) {
    const invoke = (command) =>
      window.colonyDesktop.request("invoke", { command, args: {} });
    if (localStorage.getItem(MIGRATION_MARKER) !== "complete") {
      const entries = await invoke("electron_read_frontend_migration");
      importLegacyState(localStorage, entries);
    }
    await invoke("electron_finish_frontend_migration");
    return true;
  }
  if (
    window.__TAURI_INTERNALS__ &&
    location.href === "tauri://localhost/electron-migration.html"
  ) {
    let entries = [];
    let failed = false;
    try {
      const fixture = await window.__TAURI_INTERNALS__.invoke(
        "electron_frontend_migration_fixture",
      );
      if (fixture) {
        for (const [key, value] of fixture) localStorage.setItem(key, value);
      }
      entries = collectLegacyState(localStorage);
    } catch {
      failed = true;
    }
    await window.__TAURI_INTERNALS__.invoke("electron_export_frontend_state", {
      entries,
      failed,
    });
    return true;
  }
  throw new Error("This app state transfer is not available in this window.");
})();
window.__COLONY_FRONTEND_MIGRATION__.catch((error) => {
  // Only this bundled page and native migration commands produce these errors.
  // Keeping the bounded reason lets hosted proof report startup failure safely.
  window.__COLONY_FRONTEND_MIGRATION_ERROR__ = String(
    error instanceof Error ? error.message : error,
  ).slice(0, 500);
  document.getElementById("status").textContent =
    "Colony could not restore your saved app state. Your original data is unchanged. Free some storage if needed, then retry.";
  if (window.colonyDesktop) {
    const retry = document.getElementById("retry");
    retry.hidden = false;
    retry.onclick = () =>
      window.colonyDesktop.request("shell", { operation: "relaunch" });
  }
});
