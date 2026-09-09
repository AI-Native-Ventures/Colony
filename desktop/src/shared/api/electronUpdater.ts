import { NativeChannel, type NativeUpdate } from "./nativeBridge";

type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/** Use the existing signature-verifying native updater with the outer app target. */
export async function checkElectronUpdate(
  invoke: Invoke,
  options?: { timeout?: number },
): Promise<NativeUpdate | null> {
  const metadata = await invoke<{ rid: number; version: string } | null>(
    "electron_check_for_update",
    options,
  );
  if (!metadata) return null;
  let bytes: number | undefined;
  let closed = false;
  let operation: Promise<void> | undefined;
  const assertOpen = () => {
    if (closed) throw new Error("Update handle has been closed");
  };
  const closeResource = (rid: number) =>
    invoke<void>("plugin:resources|close", { rid });
  return {
    version: metadata.version,
    download() {
      assertOpen();
      if (operation) return operation;
      if (bytes !== undefined) return Promise.resolve();
      operation = (async () => {
        const rid = await invoke<number>("plugin:updater|download", {
          rid: metadata.rid,
          onEvent: new NativeChannel(),
          timeout: 15 * 60_000,
        });
        if (closed) await closeResource(rid);
        else bytes = rid;
      })().finally(() => {
        operation = undefined;
      });
      return operation;
    },
    async install() {
      assertOpen();
      while (operation) await operation;
      assertOpen();
      if (bytes === undefined)
        throw new Error("Download and verify this update before installing");
      const rid = bytes;
      operation = invoke<void>("plugin:updater|install", {
        updateRid: metadata.rid,
        bytesRid: rid,
      })
        .then(() => {
          bytes = undefined; // The native install command closes its bytes resource.
        })
        .finally(() => {
          operation = undefined;
        });
      await operation;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await operation;
      } finally {
        try {
          if (bytes !== undefined) {
            const rid = bytes;
            bytes = undefined;
            await closeResource(rid);
          }
        } finally {
          await closeResource(metadata.rid);
        }
      }
    },
  };
}
