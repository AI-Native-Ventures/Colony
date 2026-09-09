import type { NativeUpdate } from "./nativeBridge";

type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/** The native resource owns verified bytes and cancels downloads when closed. */
export async function checkElectronUpdate(
  invoke: Invoke,
  options?: { headers?: Record<string, string> },
): Promise<NativeUpdate | null> {
  const metadata = await invoke<{ rid: number; version: string } | null>(
    "electron_check_for_update",
    options,
  );
  if (!metadata) return null;
  let downloaded = false;
  let closed = false;
  let operation: Promise<void> | undefined;
  const assertOpen = () => {
    if (closed) throw new Error("Update handle has been closed");
  };
  return {
    version: metadata.version,
    download() {
      assertOpen();
      if (operation) return operation;
      if (downloaded) return Promise.resolve();
      operation = invoke<void>("electron_download_update", {
        rid: metadata.rid,
      })
        .then(() => {
          if (!closed) downloaded = true;
        })
        .finally(() => {
          operation = undefined;
        });
      return operation;
    },
    async install() {
      assertOpen();
      while (operation) await operation;
      assertOpen();
      if (!downloaded)
        throw new Error("Download and verify this update before installing");
      operation = invoke<void>("electron_install_update", { rid: metadata.rid })
        .then(() => {
          downloaded = false;
        })
        .finally(() => {
          operation = undefined;
        });
      await operation;
    },
    async close() {
      if (closed) return;
      closed = true;
      // Closing first aborts any native download; waiting first would strand it.
      await invoke<void>("plugin:resources|close", { rid: metadata.rid });
      await operation?.catch(() => {});
    },
  };
}
