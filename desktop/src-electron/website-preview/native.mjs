/**
 * Small main-process helpers for host-mediated native artifact reads.
 *
 * Rust's raw Tauri response is serialized as `{ __colony_binary: base64 }`
 * before it reaches Electron. Keeping decoding here makes the boundary
 * explicit and gives aborting callers one place to fence a late response.
 */

/** Decode the raw IPC shapes used by Tauri/Electron into an owned Buffer. */
export function decodeNativeArtifactBytes(value) {
  const encoded =
    value &&
    typeof value === "object" &&
    typeof value.__colony_binary === "string"
      ? value.__colony_binary
      : null;
  if (encoded !== null) return Buffer.from(encoded, "base64");
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (
    value &&
    typeof value === "object" &&
    value.type === "Buffer" &&
    Array.isArray(value.data)
  ) {
    return Buffer.from(value.data);
  }
  throw new Error("The native media reader returned no bytes");
}

/**
 * Build the invoke payload for the Tauri website artifact command.
 *
 * Tauri maps Rust command parameters to camelCase at the IPC boundary. Keep
 * that adapter beside the native response decoder so a renderer-facing
 * payload cannot silently drift from the registered command contract.
 */
export function nativeWebsiteArtifactArgs({ url, ownerPubkey, relay }) {
  return {
    url,
    expectedOwnerPubkey: ownerPubkey,
    expectedRelayUrl: relay,
  };
}

/**
 * Await a host request while respecting the loader's abort signal.
 *
 * The native request cannot always be cancelled after it crosses the Tauri
 * boundary. A late result is therefore consumed and never returned, while a
 * late rejection is consumed to avoid an unhandled promise rejection.
 */
export function awaitNativeArtifact(promise, signal) {
  const pending = Promise.resolve(promise);
  if (signal === undefined || signal === null) return pending;

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const abortError = () =>
      signal.reason instanceof Error
        ? signal.reason
        : new Error("The artifact read was aborted");
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      pending.catch(() => {});
      reject(abortError());
    };
    pending.then(
      (value) => {
        if (settled) return;
        if (signal.aborted) {
          onAbort();
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
